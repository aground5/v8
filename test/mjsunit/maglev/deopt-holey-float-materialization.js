// Copyright 2024 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// Flags: --allow-natives-syntax --maglev --no-turbofan

// Setup: Create an array with a hole (HoleyFloat64).
// V8 represents the hole as a specific quiet NaN (kHoleNanInt64).
const holeyArray = [1.1, 2.2, , 4.4];

function trigger(arr, index, forceDeopt) {
  // Load the value.
  // Maglev compiles this load. Since the array is holey double,
  // 'val' is tracked as a HoleyFloat64.
  const val = arr[index];

  // Virtual Object Allocation (Allocation Elimination).
  // We create a temporary object. Maglev sees it doesn't escape
  // (until the deopt point), so it optimizes it away.
  // It records 'val' as a field of this virtual object in the
  // translation frame.
  const wrapper = { value: val };

  // Deoptimization Trigger.
  if (forceDeopt) {
    // We force a deopt here. The Deoptimizer must now:
    // a. Reconstruct the stack frame.
    // b. Materialize the 'wrapper' object (because it conceptually exists).
    // c. To materialize 'wrapper', it calls GetValue() for 'wrapper.value'.
    %DeoptimizeNow();
  }

  return wrapper.value;
}

%PrepareFunctionForOptimization(trigger);

// Warmup Maglev
for (let i = 0; i < 20000; i++) {
  trigger(holeyArray, 0, false);
}

%OptimizeMaglevOnNextCall(trigger);
trigger(holeyArray, 0, false);

// Trigger the leak.
// Index 2 is the hole.
const result = trigger(holeyArray, 2, true);

// Verification
// In a correct implementation, the hole should be converted to undefined.
// In the vulnerable implementation, it leaks as a NaN HeapNumber.
if (Number.isNaN(result)) {
  // If we found a NaN, we assume it's the leaked hole.
  // We can't easily check the exact bit pattern in pure JS without more complex setup,
  // but getting a NaN from a hole load that should be undefined is enough evidence.
  print("VULNERABILITY REPRODUCED: Leaked Hole sentinel as NaN!");
} else if (result === undefined) {
  print("Safe: Correctly converted to undefined.");
} else {
  print("Unexpected result: " + result);
}

assertEquals(undefined, result);
