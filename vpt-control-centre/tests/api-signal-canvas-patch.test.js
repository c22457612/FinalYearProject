const test = require("node:test");
const assert = require("node:assert/strict");

const { createMethodPatchController } = require("../../extension/api-signal-canvas-patch.js");

test("canvas patch controller wraps a method when it becomes available after an earlier miss", () => {
  const controller = createMethodPatchController();
  const proto = {};
  const calls = [];

  const wrapFn = function wrapped(original, args) {
    calls.push(args[0]);
    return original.apply(this, args);
  };

  assert.equal(controller.patchMethod(proto, "toDataURL", wrapFn), false);

  proto.toDataURL = function toDataURL(format) {
    return `native:${format}`;
  };

  assert.equal(controller.patchMethod(proto, "toDataURL", wrapFn), true);
  assert.equal(proto.toDataURL("image/png"), "native:image/png");
  assert.deepEqual(calls, ["image/png"]);
});

test("canvas patch controller keeps prototype assignments wrapped after initial patch", () => {
  const controller = createMethodPatchController();
  const proto = {
    getImageData(width, height) {
      return { width, height, source: "native" };
    },
  };
  const calls = [];

  const wrapFn = function wrapped(original, args) {
    calls.push(args.join("x"));
    return original.apply(this, args);
  };

  assert.equal(controller.patchMethod(proto, "getImageData", wrapFn), true);
  assert.deepEqual(proto.getImageData(2, 3), { width: 2, height: 3, source: "native" });

  proto.getImageData = function reassigned(width, height) {
    return { width, height, source: "reassigned" };
  };

  assert.deepEqual(proto.getImageData(4, 5), { width: 4, height: 5, source: "reassigned" });
  assert.deepEqual(calls, ["2x3", "4x5"]);
});

test("canvas patch controller can rewrap a defineProperty replacement on a later retry", () => {
  const controller = createMethodPatchController();
  const proto = {};
  const calls = [];

  Object.defineProperty(proto, "toBlob", {
    configurable: true,
    enumerable: false,
    writable: true,
    value(callback) {
      callback("native");
    },
  });

  const wrapFn = function wrapped(original, args) {
    calls.push("wrapped");
    return original.apply(this, args);
  };

  assert.equal(controller.patchMethod(proto, "toBlob", wrapFn), true);

  const firstValues = [];
  proto.toBlob((value) => firstValues.push(value));
  assert.deepEqual(firstValues, ["native"]);
  assert.deepEqual(calls, ["wrapped"]);

  Object.defineProperty(proto, "toBlob", {
    configurable: true,
    enumerable: false,
    writable: true,
    value(callback) {
      callback("redefined");
    },
  });

  calls.length = 0;
  const beforeRetryValues = [];
  proto.toBlob((value) => beforeRetryValues.push(value));
  assert.deepEqual(beforeRetryValues, ["redefined"]);
  assert.deepEqual(calls, []);

  assert.equal(controller.patchMethod(proto, "toBlob", wrapFn), true);

  const afterRetryValues = [];
  proto.toBlob((value) => afterRetryValues.push(value));
  assert.deepEqual(afterRetryValues, ["redefined"]);
  assert.deepEqual(calls, ["wrapped"]);
});
