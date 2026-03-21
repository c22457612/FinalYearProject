(function initVptCanvasPatchShared(globalScope) {
  const API = {};
  const nativeDefineProperty = Object.defineProperty;
  const stateByPrototype = new WeakMap();

  function getPrototypeState(proto) {
    let state = stateByPrototype.get(proto);
    if (!state) {
      state = new Map();
      stateByPrototype.set(proto, state);
    }
    return state;
  }

  function isAccessorDescriptor(descriptor) {
    if (!descriptor || typeof descriptor !== "object") return false;
    return typeof descriptor.get === "function" || typeof descriptor.set === "function";
  }

  function readDescriptorValue(proto, methodName, descriptor) {
    if (!descriptor) return proto?.[methodName];
    if (Object.prototype.hasOwnProperty.call(descriptor, "value")) return descriptor.value;
    if (isAccessorDescriptor(descriptor)) {
      try {
        return proto?.[methodName];
      } catch {
        return null;
      }
    }
    return proto?.[methodName];
  }

  function createMethodPatchController({ patchedFlag = "__vpt_api_patched" } = {}) {
    function isPatchedFunction(value) {
      return typeof value === "function" && value[patchedFlag] === true;
    }

    function markPatchedFunction(fn) {
      if (typeof fn !== "function") return fn;
      try {
        nativeDefineProperty(fn, patchedFlag, {
          value: true,
          configurable: true,
          enumerable: false,
          writable: false,
        });
      } catch {
        try {
          fn[patchedFlag] = true;
        } catch {
          // Ignore marker failures and fall back to best-effort wrapping.
        }
      }
      return fn;
    }

    function buildWrappedFunction(original, wrapFn) {
      if (typeof original !== "function") return original;
      if (isPatchedFunction(original)) return original;
      const wrapped = function vptPatchedMethod(...args) {
        return wrapFn.call(this, original, args);
      };
      return markPatchedFunction(wrapped);
    }

    function patchMethod(proto, methodName, wrapFn) {
      if (!proto || typeof methodName !== "string" || typeof wrapFn !== "function") return false;

      const descriptor = Object.getOwnPropertyDescriptor(proto, methodName);
      const currentValue = readDescriptorValue(proto, methodName, descriptor);
      if (typeof currentValue !== "function") return false;

      const protoState = getPrototypeState(proto);
      const existingState = protoState.get(methodName);
      if (
        existingState
        && existingState.wrapFn === wrapFn
        && isAccessorDescriptor(descriptor)
        && typeof descriptor.get === "function"
        && typeof currentValue === "function"
        && isPatchedFunction(currentValue)
      ) {
        return true;
      }

      if (descriptor && descriptor.configurable === false) {
        if (descriptor.writable !== true || isPatchedFunction(currentValue)) {
          return isPatchedFunction(currentValue);
        }
        try {
          proto[methodName] = buildWrappedFunction(currentValue, wrapFn);
          return isPatchedFunction(proto[methodName]);
        } catch {
          return false;
        }
      }

      const enumerable = descriptor?.enumerable === true;
      let currentWrapped = buildWrappedFunction(currentValue, wrapFn);

      try {
        nativeDefineProperty(proto, methodName, {
          configurable: true,
          enumerable,
          get() {
            return currentWrapped;
          },
          set(nextValue) {
            currentWrapped = buildWrappedFunction(nextValue, wrapFn);
          },
        });
      } catch {
        return false;
      }

      protoState.set(methodName, { wrapFn });
      return true;
    }

    return {
      patchMethod,
      isPatchedFunction,
    };
  }

  API.createMethodPatchController = createMethodPatchController;

  globalScope.__VPTCanvasPatchShared = API;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = API;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
