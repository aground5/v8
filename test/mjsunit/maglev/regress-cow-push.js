// Copyright 2024 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// Flags: --allow-natives-syntax --maglev

function push(arr, val) {
  arr.push(val);
}

function test() {
  // Create a COW array.
  // [1, 2, 3] constant elements are usually COW.
  let a = [1, 2, 3];
  let b = [1, 2, 3];

  // Shrink a. This keeps the capacity (3) but length becomes 1.
  // The backing store is still the COW fixed array.
  a.length = 1;

  // Push to a.
  // If Maglev logic is buggy, it sees capacity 3, length 1, so it thinks it can write to index 1.
  // It effectively does a[1] = 42.
  // If it doesn't check for COW, it writes to the COW array.
  // Since 'b' shares the same COW array, b[1] would become 42.
  push(a, 42);

  // 'a' should have transitioned to a new writable backing store.
  // 'b' should still point to the original COW backing store.
  // So b[1] should be 2.
  if (b[1] !== 2) {
    throw new Error("COW array corruption detected! b[1] = " + b[1]);
  }
}

%PrepareFunctionForOptimization(push);
test();
test();
%OptimizeMaglevOnNextCall(push);
test();
