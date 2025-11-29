// PoC for Maglev OOB or Type Confusion candidate
// Targeting Array.prototype.push optimization in Maglev

function push_wrapper(arr, val) {
  return arr.push(val);
}

function trigger() {
  const arr = [1.1];
  // Force HOLEY_DOUBLE_ELEMENTS
  arr[0] = 1.1;
  arr[100] = 1.1;

  // Warmup to trigger Maglev compilation
  for (let i = 0; i < 10000; i++) {
    push_wrapper(arr, i + 0.5);
  }

  // Try to confuse the map check by transitioning the array
  // right before a call (if we can interleave execution).
  // But push_wrapper is simple.

  // Let's try a transition inside the loop?
  const arr2 = [1.1];
  push_wrapper(arr2, 1.1);
  // arr2 is PACKED_DOUBLE

  // Now pass an object that looks like an array but isn't?
  // Maglev has CheckMaps.
}

trigger();
