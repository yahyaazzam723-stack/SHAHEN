/**
 * Copyright (c) 2014-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

var runtime = (function (exports) {
  "use strict";

  var Op = Object.prototype;
  var hasOwn = Op.hasOwnProperty;
  var defineProperty = Object.defineProperty || function (obj, key, desc) { obj[key] = desc.value; };
  var undefined; // More compressible than void 0.
  var $Symbol = typeof Symbol === "function" ? Symbol : {};
  var iteratorSymbol = $Symbol.iterator || "@@iterator";
  var asyncIteratorSymbol = $Symbol.asyncIterator || "@@asyncIterator";
  var toStringTagSymbol = $Symbol.toStringTag || "@@toStringTag";

  function define(obj, key, value) {
    Object.defineProperty(obj, key, {
      value: value,
      enumerable: true,
      configurable: true,
      writable: true
    });
    return obj[key];
  }
  try {
    // IE 8 has a broken Object.defineProperty that only works on DOM objects.
    define({}, "");
  } catch (err) {
    define = function(obj, key, value) {
      return obj[key] = value;
    };
  }

  function wrap(innerFn, outerFn, self, tryLocsList) {
    // If outerFn provided and outerFn.prototype is a Generator, then outerFn.prototype instanceof Generator.
    var protoGenerator = outerFn && outerFn.prototype instanceof Generator ? outerFn : Generator;
    var generator = Object.create(protoGenerator.prototype);
    var context = new Context(tryLocsList || []);

    // The ._invoke method unifies the implementations of the .next,
    // .throw, and .return methods.
    defineProperty(generator, "_invoke", { value: makeInvokeMethod(innerFn, self, context) });

    return generator;
  }
  exports.wrap = wrap;

  // Try/catch helper to minimize deoptimizations. Returns a completion
  // record like context.tryEntries[i].completion. This interface could
  // have been (and was previously) designed to take a closure to be
  // invoked without arguments, but in all the cases we care about we
  // already have an existing method we want to call, so there's no need
  // to create a new function object. We can even get away with assuming
  // the method takes exactly one argument, since that happens to be true
  // in every case, so we don't have to touch the arguments object. The
  // only additional allocation required is the completion record, which
  // has a stable shape and so hopefully should be cheap to allocate.
  function tryCatch(fn, obj, arg) {
    try {
      return { type: "normal", arg: fn.call(obj, arg) };
    } catch (err) {
      return { type: "throw", arg: err };
    }
  }

  var GenStateSuspendedStart = "suspendedStart";
  var GenStateSuspendedYield = "suspendedYield";
  var GenStateExecuting = "executing";
  var GenStateCompleted = "completed";

  // Returning this object from the innerFn has the same effect as
  // breaking out of the dispatch switch statement.
  var ContinueSentinel = {};

  // Dummy constructor functions that we use as the .constructor and
  // .constructor.prototype properties for functions that return Generator
  // objects. For full spec compliance, you may wish to configure your
  // minifier not to mangle the names of these two functions.
  function Generator() {}
  function GeneratorFunction() {}
  function GeneratorFunctionPrototype() {}

  // This is a polyfill for %IteratorPrototype% for environments that
  // don't natively support it.
  var IteratorPrototype = {};
  define(IteratorPrototype, iteratorSymbol, function () {
    return this;
  });

  var getProto = Object.getPrototypeOf;
  var NativeIteratorPrototype = getProto && getProto(getProto(values([])));
  if (NativeIteratorPrototype &&
      NativeIteratorPrototype !== Op &&
      hasOwn.call(NativeIteratorPrototype, iteratorSymbol)) {
    // This environment has a native %IteratorPrototype%; use it instead
    // of the polyfill.
    IteratorPrototype = NativeIteratorPrototype;
  }

  var Gp = GeneratorFunctionPrototype.prototype =
    Generator.prototype = Object.create(IteratorPrototype);
  GeneratorFunction.prototype = GeneratorFunctionPrototype;
  defineProperty(Gp, "constructor", { value: GeneratorFunctionPrototype, configurable: true });
  defineProperty(
    GeneratorFunctionPrototype,
    "constructor",
    { value: GeneratorFunction, configurable: true }
  );
  GeneratorFunction.displayName = define(
    GeneratorFunctionPrototype,
    toStringTagSymbol,
    "GeneratorFunction"
  );

  // Helper for defining the .next, .throw, and .return methods of the
  // Iterator interface in terms of a single ._invoke method.
  function defineIteratorMethods(prototype) {
    ["next", "throw", "return"].forEach(function(method) {
      define(prototype, method, function(arg) {
        return this._invoke(method, arg);
      });
    });
  }

  exports.isGeneratorFunction = function(genFun) {
    var ctor = typeof genFun === "function" && genFun.constructor;
    return ctor
      ? ctor === GeneratorFunction ||
        // For the native GeneratorFunction constructor, the best we can
        // do is to check its .name property.
        (ctor.displayName || ctor.name) === "GeneratorFunction"
      : false;
  };

  exports.mark = function(genFun) {
    if (Object.setPrototypeOf) {
      Object.setPrototypeOf(genFun, GeneratorFunctionPrototype);
    } else {
      genFun.__proto__ = GeneratorFunctionPrototype;
      define(genFun, toStringTagSymbol, "GeneratorFunction");
    }
    genFun.prototype = Object.create(Gp);
    return genFun;
  };

  // Within the body of any async function, `await x` is transformed to
  // `yield regeneratorRuntime.awrap(x)`, so that the runtime can test
  // `hasOwn.call(value, "__await")` to determine if the yielded value is
  // meant to be awaited.
  exports.awrap = function(arg) {
    return { __await: arg };
  };

  function AsyncIterator(generator, PromiseImpl) {
    function invoke(method, arg, resolve, reject) {
      var record = tryCatch(generator[method], generator, arg);
      if (record.type === "throw") {
        reject(record.arg);
      } else {
        var result = record.arg;
        var value = result.value;
        if (value &&
            typeof value === "object" &&
            hasOwn.call(value, "__await")) {
          return PromiseImpl.resolve(value.__await).then(function(value) {
            invoke("next", value, resolve, reject);
          }, function(err) {
            invoke("throw", err, resolve, reject);
          });
        }

        return PromiseImpl.resolve(value).then(function(unwrapped) {
          // When a yielded Promise is resolved, its final value becomes
          // the .value of the Promise<{value,done}> result for the
          // current iteration.
          result.value = unwrapped;
          resolve(result);
        }, function(error) {
          // If a rejected Promise was yielded, throw the rejection back
          // into the async generator function so it can be handled there.
          return invoke("throw", error, resolve, reject);
        });
      }
    }

    var previousPromise;

    function enqueue(method, arg) {
      function callInvokeWithMethodAndArg() {
        return new PromiseImpl(function(resolve, reject) {
          invoke(method, arg, resolve, reject);
        });
      }

      return previousPromise =
        // If enqueue has been called before, then we want to wait until
        // all previous Promises have been resolved before calling invoke,
        // so that results are always delivered in the correct order. If
        // enqueue has not been called before, then it is important to
        // call invoke immediately, without waiting on a callback to fire,
        // so that the async generator function has the opportunity to do
        // any necessary setup in a predictable way. This predictability
        // is why the Promise constructor synchronously invokes its
        // executor callback, and why async functions synchronously
        // execute code before the first await. Since we implement simple
        // async functions in terms of async generators, it is especially
        // important to get this right, even though it requires care.
        previousPromise ? previousPromise.then(
          callInvokeWithMethodAndArg,
          // Avoid propagating failures to Promises returned by later
          // invocations of the iterator.
          callInvokeWithMethodAndArg
        ) : callInvokeWithMethodAndArg();
    }

    // Define the unified helper method that is used to implement .next,
    // .throw, and .return (see defineIteratorMethods).
    defineProperty(this, "_invoke", { value: enqueue });
  }

  defineIteratorMethods(AsyncIterator.prototype);
  define(AsyncIterator.prototype, asyncIteratorSymbol, function () {
    return this;
  });
  exports.AsyncIterator = AsyncIterator;

  // Note that simple async functions are implemented on top of
  // AsyncIterator objects; they just return a Promise for the value of
  // the final result produced by the iterator.
  exports.async = function(innerFn, outerFn, self, tryLocsList, PromiseImpl) {
    if (PromiseImpl === void 0) PromiseImpl = Promise;

    var iter = new AsyncIterator(
      wrap(innerFn, outerFn, self, tryLocsList),
      PromiseImpl
    );

    return exports.isGeneratorFunction(outerFn)
      ? iter // If outerFn is a generator, return the full iterator.
      : iter.next().then(function(result) {
          return result.done ? result.value : iter.next();
        });
  };

  function makeInvokeMethod(innerFn, self, context) {
    var state = GenStateSuspendedStart;

    return function invoke(method, arg) {
      if (state === GenStateExecuting) {
        throw new Error("Generator is already running");
      }

      if (state === GenStateCompleted) {
        if (method === "throw") {
          throw arg;
        }

        // Be forgiving, per GeneratorResume behavior specified since ES2015:
        // ES2015 spec, step 3: https://262.ecma-international.org/6.0/#sec-generatorresume
        // Latest spec, step 2: https://tc39.es/ecma262/#sec-generatorresume
        return doneResult();
      }

      context.method = method;
      context.arg = arg;

      while (true) {
        var delegate = context.delegate;
        if (delegate) {
          var delegateResult = maybeInvokeDelegate(delegate, context);
          if (delegateResult) {
            if (delegateResult === ContinueSentinel) continue;
            return delegateResult;
          }
        }

        if (context.method === "next") {
          // Setting context._sent for legacy support of Babel's
          // function.sent implementation.
          context.sent = context._sent = context.arg;

        } else if (context.method === "throw") {
          if (state === GenStateSuspendedStart) {
            state = GenStateCompleted;
            throw context.arg;
          }

          context.dispatchException(context.arg);

        } else if (context.method === "return") {
          context.abrupt("return", context.arg);
        }

        state = GenStateExecuting;

        var record = tryCatch(innerFn, self, context);
        if (record.type === "normal") {
          // If an exception is thrown from innerFn, we leave state ===
          // GenStateExecuting and loop back for another invocation.
          state = context.done
            ? GenStateCompleted
            : GenStateSuspendedYield;

          if (record.arg === ContinueSentinel) {
            continue;
          }

          return {
            value: record.arg,
            done: context.done
          };

        } else if (record.type === "throw") {
          state = GenStateCompleted;
          // Dispatch the exception by looping back around to the
          // context.dispatchException(context.arg) call above.
          context.method = "throw";
          context.arg = record.arg;
        }
      }
    };
  }

  // Call delegate.iterator[context.method](context.arg) and handle the
  // result, either by returning a { value, done } result from the
  // delegate iterator, or by modifying context.method and context.arg,
  // setting context.delegate to null, and returning the ContinueSentinel.
  function maybeInvokeDelegate(delegate, context) {
    var methodName = context.method;
    var method = delegate.iterator[methodName];
    if (method === undefined) {
      // A .throw or .return when the delegate iterator has no .throw
      // method, or a missing .next method, always terminate the
      // yield* loop.
      context.delegate = null;

      // Note: ["return"] must be used for ES3 parsing compatibility.
      if (methodName === "throw" && delegate.iterator["return"]) {
        // If the delegate iterator has a return method, give it a
        // chance to clean up.
        context.method = "return";
        context.arg = undefined;
        maybeInvokeDelegate(delegate, context);

        if (context.method === "throw") {
          // If maybeInvokeDelegate(context) changed context.method from
          // "return" to "throw", let that override the TypeError below.
          return ContinueSentinel;
        }
      }
      if (methodName !== "return") {
        context.method = "throw";
        context.arg = new TypeError(
          "The iterator does not provide a '" + methodName + "' method");
      }

      return ContinueSentinel;
    }

    var record = tryCatch(method, delegate.iterator, context.arg);

    if (record.type === "throw") {
      context.method = "throw";
      context.arg = record.arg;
      context.delegate = null;
      return ContinueSentinel;
    }

    var info = record.arg;

    if (! info) {
      context.method = "throw";
      context.arg = new TypeError("iterator result is not an object");
      context.delegate = null;
      return ContinueSentinel;
    }

    if (info.done) {
      // Assign the result of the finished delegate to the temporary
      // variable specified by delegate.resultName (see delegateYield).
      context[delegate.resultName] = info.value;

      // Resume execution at the desired location (see delegateYield).
      context.next = delegate.nextLoc;

      // If context.method was "throw" but the delegate handled the
      // exception, let the outer generator proceed normally. If
      // context.method was "next", forget context.arg since it has been
      // "consumed" by the delegate iterator. If context.method was
      // "return", allow the original .return call to continue in the
      // outer generator.
      if (context.method !== "return") {
        context.method = "next";
        context.arg = undefined;
      }

    } else {
      // Re-yield the result returned by the delegate method.
      return info;
    }

    // The delegate iterator is finished, so forget it and continue with
    // the outer generator.
    context.delegate = null;
    return ContinueSentinel;
  }

  // Define Generator.prototype.{next,throw,return} in terms of the
  // unified ._invoke helper method.
  defineIteratorMethods(Gp);

  define(Gp, toStringTagSymbol, "Generator");

  // A Generator should always return itself as the iterator object when the
  // @@iterator function is called on it. Some browsers' implementations of the
  // iterator prototype chain incorrectly implement this, causing the Generator
  // object to not be returned from this call. This ensures that doesn't happen.
  // See https://github.com/facebook/regenerator/issues/274 for more details.
  define(Gp, iteratorSymbol, function() {
    return this;
  });

  define(Gp, "toString", function() {
    return "[object Generator]";
  });

  function pushTryEntry(locs) {
    var entry = { tryLoc: locs[0] };

    if (1 in locs) {
      entry.catchLoc = locs[1];
    }

    if (2 in locs) {
      entry.finallyLoc = locs[2];
      entry.afterLoc = locs[3];
    }

    this.tryEntries.push(entry);
  }

  function resetTryEntry(entry) {
    var record = entry.completion || {};
    record.type = "normal";
    delete record.arg;
    entry.completion = record;
  }

  function Context(tryLocsList) {
    // The root entry object (effectively a try statement without a catch
    // or a finally block) gives us a place to store values thrown from
    // locations where there is no enclosing try statement.
    this.tryEntries = [{ tryLoc: "root" }];
    tryLocsList.forEach(pushTryEntry, this);
    this.reset(true);
  }

  exports.keys = function(val) {
    var object = Object(val);
    var keys = [];
    for (var key in object) {
      keys.push(key);
    }
    keys.reverse();

    // Rather than returning an object with a next method, we keep
    // things simple and return the next function itself.
    return function next() {
      while (keys.length) {
        var key = keys.pop();
        if (key in object) {
          next.value = key;
          next.done = false;
          return next;
        }
      }

      // To avoid creating an additional object, we just hang the .value
      // and .done properties off the next function object itself. This
      // also ensures that the minifier will not anonymize the function.
      next.done = true;
      return next;
    };
  };

  function values(iterable) {
    if (iterable != null) {
      var iteratorMethod = iterable[iteratorSymbol];
      if (iteratorMethod) {
        return iteratorMethod.call(iterable);
      }

      if (typeof iterable.next === "function") {
        return iterable;
      }

      if (!isNaN(iterable.length)) {
        var i = -1, next = function next() {
          while (++i < iterable.length) {
            if (hasOwn.call(iterable, i)) {
              next.value = iterable[i];
              next.done = false;
              return next;
            }
          }

          next.value = undefined;
          next.done = true;

          return next;
        };

        return next.next = next;
      }
    }

    throw new TypeError(typeof iterable + " is not iterable");
  }
  exports.values = values;

  function doneResult() {
    return { value: undefined, done: true };
  }

  Context.prototype = {
    constructor: Context,

    reset: function(skipTempReset) {
      this.prev = 0;
      this.next = 0;
      // Resetting context._sent for legacy support of Babel's
      // function.sent implementation.
      this.sent = this._sent = undefined;
      this.done = false;
      this.delegate = null;

      this.method = "next";
      this.arg = undefined;

      this.tryEntries.forEach(resetTryEntry);

      if (!skipTempReset) {
        for (var name in this) {
          // Not sure about the optimal order of these conditions:
          if (name.charAt(0) === "t" &&
              hasOwn.call(this, name) &&
              !isNaN(+name.slice(1))) {
            this[name] = undefined;
          }
        }
      }
    },

    stop: function() {
      this.done = true;

      var rootEntry = this.tryEntries[0];
      var rootRecord = rootEntry.completion;
      if (rootRecord.type === "throw") {
        throw rootRecord.arg;
      }

      return this.rval;
    },

    dispatchException: function(exception) {
      if (this.done) {
        throw exception;
      }

      var context = this;
      function handle(loc, caught) {
        record.type = "throw";
        record.arg = exception;
        context.next = loc;

        if (caught) {
          // If the dispatched exception was caught by a catch block,
          // then let that catch block handle the exception normally.
          context.method = "next";
          context.arg = undefined;
        }

        return !! caught;
      }

      for (var i = this.tryEntries.length - 1; i >= 0; --i) {
        var entry = this.tryEntries[i];
        var record = entry.completion;

        if (entry.tryLoc === "root") {
          // Exception thrown outside of any try block that could handle
          // it, so set the completion value of the entire function to
          // throw the exception.
          return handle("end");
        }

        if (entry.tryLoc <= this.prev) {
          var hasCatch = hasOwn.call(entry, "catchLoc");
          var hasFinally = hasOwn.call(entry, "finallyLoc");

          if (hasCatch && hasFinally) {
            if (this.prev < entry.catchLoc) {
              return handle(entry.catchLoc, true);
            } else if (this.prev < entry.finallyLoc) {
              return handle(entry.finallyLoc);
            }

          } else if (hasCatch) {
            if (this.prev < entry.catchLoc) {
              return handle(entry.catchLoc, true);
            }

          } else if (hasFinally) {
            if (this.prev < entry.finallyLoc) {
              return handle(entry.finallyLoc);
            }

          } else {
            throw new Error("try statement without catch or finally");
          }
        }
      }
    },

    abrupt: function(type, arg) {
      for (var i = this.tryEntries.length - 1; i >= 0; --i) {
        var entry = this.tryEntries[i];
        if (entry.tryLoc <= this.prev &&
            hasOwn.call(entry, "finallyLoc") &&
            this.prev < entry.finallyLoc) {
          var finallyEntry = entry;
          break;
        }
      }

      if (finallyEntry &&
          (type === "break" ||
           type === "continue") &&
          finallyEntry.tryLoc <= arg &&
          arg <= finallyEntry.finallyLoc) {
        // Ignore the finally entry if control is not jumping to a
        // location outside the try/catch block.
        finallyEntry = null;
      }

      var record = finallyEntry ? finallyEntry.completion : {};
      record.type = type;
      record.arg = arg;

      if (finallyEntry) {
        this.method = "next";
        this.next = finallyEntry.finallyLoc;
        return ContinueSentinel;
      }

      return this.complete(record);
    },

    complete: function(record, afterLoc) {
      if (record.type === "throw") {
        throw record.arg;
      }

      if (record.type === "break" ||
          record.type === "continue") {
        this.next = record.arg;
      } else if (record.type === "return") {
        this.rval = this.arg = record.arg;
        this.method = "return";
        this.next = "end";
      } else if (record.type === "normal" && afterLoc) {
        this.next = afterLoc;
      }

      return ContinueSentinel;
    },

    finish: function(finallyLoc) {
      for (var i = this.tryEntries.length - 1; i >= 0; --i) {
        var entry = this.tryEntries[i];
        if (entry.finallyLoc === finallyLoc) {
          this.complete(entry.completion, entry.afterLoc);
          resetTryEntry(entry);
          return ContinueSentinel;
        }
      }
    },

    "catch": function(tryLoc) {
      for (var i = this.tryEntries.length - 1; i >= 0; --i) {
        var entry = this.tryEntries[i];
        if (entry.tryLoc === tryLoc) {
          var record = entry.completion;
          if (record.type === "throw") {
            var thrown = record.arg;
            resetTryEntry(entry);
          }
          return thrown;
        }
      }

      // The context.catch method must only be called with a location
      // argument that corresponds to a known catch block.
      throw new Error("illegal catch attempt");
    },

    delegateYield: function(iterable, resultName, nextLoc) {
      this.delegate = {
        iterator: values(iterable),
        resultName: resultName,
        nextLoc: nextLoc
      };

      if (this.method === "next") {
        // Deliberately forget the last sent value so that we don't
        // accidentally pass it on to the delegate.
        this.arg = undefined;
      }

      return ContinueSentinel;
    }
  };

  // Regardless of whether this script is executing as a CommonJS module
  // or not, return the runtime object so that we can declare the variable
  // regeneratorRuntime in the outer scope, which allows this module to be
  // injected easily by `bin/regenerator --include-runtime script.js`.
  return exports;

}(
  // If this script is executing as a CommonJS module, use module.exports
  // as the regeneratorRuntime namespace. Otherwise create a new empty
  // object. Either way, the resulting object will be used to initialize
  // the regeneratorRuntime variable at the top of this file.
  typeof module === "object" ? module.exports : {}
));

try {
  regeneratorRuntime = runtime;
} catch (accidentalStrictMode) {
  // This module should not be running in strict mode, so the above
  // assignment should always work unless something is misconfigured. Just
  // in case runtime.js accidentally runs in strict mode, in modern engines
  // we can explicitly access globalThis. In older engines we can escape
  // strict mode using a global Function call. This could conceivably fail
  // if a Content Security Policy forbids using Function, but in that case
  // the proper solution is to fix the accidental strict mode problem. If
  // you've misconfigured your bundler to force strict mode and applied a
  // CSP to forbid Function, and you're not willing to fix either of those
  // problems, please detail your unique predicament in a GitHub issue.
  if (typeof globalThis === "object") {
    globalThis.regeneratorRuntime = runtime;
  } else {
    Function("r", "regeneratorRuntime = r")(runtime);
  }
}
function ownKeys(e, r) { var t = Object.keys(e); if (Object.getOwnPropertySymbols) { var o = Object.getOwnPropertySymbols(e); r && (o = o.filter(function (r) { return Object.getOwnPropertyDescriptor(e, r).enumerable; })), t.push.apply(t, o); } return t; }
function _objectSpread(e) { for (var r = 1; r < arguments.length; r++) { var t = null != arguments[r] ? arguments[r] : {}; r % 2 ? ownKeys(Object(t), !0).forEach(function (r) { _defineProperty(e, r, t[r]); }) : Object.getOwnPropertyDescriptors ? Object.defineProperties(e, Object.getOwnPropertyDescriptors(t)) : ownKeys(Object(t)).forEach(function (r) { Object.defineProperty(e, r, Object.getOwnPropertyDescriptor(t, r)); }); } return e; }
function _defineProperty(e, r, t) { return (r = _toPropertyKey(r)) in e ? Object.defineProperty(e, r, { value: t, enumerable: !0, configurable: !0, writable: !0 }) : e[r] = t, e; }
function _toPropertyKey(t) { var i = _toPrimitive(t, "string"); return "symbol" == typeof i ? i : i + ""; }
function _toPrimitive(t, r) { if ("object" != typeof t || !t) return t; var e = t[Symbol.toPrimitive]; if (void 0 !== e) { var i = e.call(t, r || "default"); if ("object" != typeof i) return i; throw new TypeError("@@toPrimitive must return a primitive value."); } return ("string" === r ? String : Number)(t); }
function _createForOfIteratorHelper(r, e) { var t = "undefined" != typeof Symbol && r[Symbol.iterator] || r["@@iterator"]; if (!t) { if (Array.isArray(r) || (t = _unsupportedIterableToArray(r)) || e && r && "number" == typeof r.length) { t && (r = t); var _n31 = 0, F = function F() {}; return { s: F, n: function n() { return _n31 >= r.length ? { done: !0 } : { done: !1, value: r[_n31++] }; }, e: function e(r) { throw r; }, f: F }; } throw new TypeError("Invalid attempt to iterate non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method."); } var o, a = !0, u = !1; return { s: function s() { t = t.call(r); }, n: function n() { var r = t.next(); return a = r.done, r; }, e: function e(r) { u = !0, o = r; }, f: function f() { try { a || null == t.return || t.return(); } finally { if (u) throw o; } } }; }
function _slicedToArray(r, e) { return _arrayWithHoles(r) || _iterableToArrayLimit(r, e) || _unsupportedIterableToArray(r, e) || _nonIterableRest(); }
function _nonIterableRest() { throw new TypeError("Invalid attempt to destructure non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method."); }
function _unsupportedIterableToArray(r, a) { if (r) { if ("string" == typeof r) return _arrayLikeToArray(r, a); var t = {}.toString.call(r).slice(8, -1); return "Object" === t && r.constructor && (t = r.constructor.name), "Map" === t || "Set" === t ? Array.from(r) : "Arguments" === t || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(t) ? _arrayLikeToArray(r, a) : void 0; } }
function _arrayLikeToArray(r, a) { (null == a || a > r.length) && (a = r.length); for (var e = 0, n = Array(a); e < a; e++) n[e] = r[e]; return n; }
function _iterableToArrayLimit(r, l) { var t = null == r ? null : "undefined" != typeof Symbol && r[Symbol.iterator] || r["@@iterator"]; if (null != t) { var e, n, i, u, a = [], f = !0, o = !1; try { if (i = (t = t.call(r)).next, 0 === l) { if (Object(t) !== t) return; f = !1; } else for (; !(f = (e = i.call(t)).done) && (a.push(e.value), a.length !== l); f = !0); } catch (r) { o = !0, n = r; } finally { try { if (!f && null != t.return && (u = t.return(), Object(u) !== u)) return; } finally { if (o) throw n; } } return a; } }
function _arrayWithHoles(r) { if (Array.isArray(r)) return r; }
function _regeneratorValues(e) { if (null != e) { var t = e["function" == typeof Symbol && Symbol.iterator || "@@iterator"], r = 0; if (t) return t.call(e); if ("function" == typeof e.next) return e; if (!isNaN(e.length)) return { next: function next() { return e && r >= e.length && (e = void 0), { value: e && e[r++], done: !e }; } }; } throw new TypeError(typeof e + " is not iterable"); }
function asyncGeneratorStep(n, t, e, r, o, a, c) { try { var i = n[a](c), u = i.value; } catch (n) { return void e(n); } i.done ? t(u) : Promise.resolve(u).then(r, o); }
function _asyncToGenerator(n) { return function () { var t = this, e = arguments; return new Promise(function (r, o) { var a = n.apply(t, e); function _next(n) { asyncGeneratorStep(a, r, o, _next, _throw, "next", n); } function _throw(n) { asyncGeneratorStep(a, r, o, _next, _throw, "throw", n); } _next(void 0); }); }; }
function _regenerator() { /*! regenerator-runtime -- Copyright (c) 2014-present, Facebook, Inc. -- license (MIT): https://github.com/babel/babel/blob/main/packages/babel-helpers/LICENSE */ var e, t, r = "function" == typeof Symbol ? Symbol : {}, n = r.iterator || "@@iterator", o = r.toStringTag || "@@toStringTag"; function i(r, n, o, i) { var c = n && n.prototype instanceof Generator ? n : Generator, u = Object.create(c.prototype); return _regeneratorDefine2(u, "_invoke", function (r, n, o) { var i, c, u, f = 0, p = o || [], y = !1, G = { p: 0, n: 0, v: e, a: d, f: d.bind(e, 4), d: function d(t, r) { return i = t, c = 0, u = e, G.n = r, a; } }; function d(r, n) { for (c = r, u = n, t = 0; !y && f && !o && t < p.length; t++) { var o, i = p[t], d = G.p, l = i[2]; r > 3 ? (o = l === n) && (u = i[(c = i[4]) ? 5 : (c = 3, 3)], i[4] = i[5] = e) : i[0] <= d && ((o = r < 2 && d < i[1]) ? (c = 0, G.v = n, G.n = i[1]) : d < l && (o = r < 3 || i[0] > n || n > l) && (i[4] = r, i[5] = n, G.n = l, c = 0)); } if (o || r > 1) return a; throw y = !0, n; } return function (o, p, l) { if (f > 1) throw TypeError("Generator is already running"); for (y && 1 === p && d(p, l), c = p, u = l; (t = c < 2 ? e : u) || !y;) { i || (c ? c < 3 ? (c > 1 && (G.n = -1), d(c, u)) : G.n = u : G.v = u); try { if (f = 2, i) { if (c || (o = "next"), t = i[o]) { if (!(t = t.call(i, u))) throw TypeError("iterator result is not an object"); if (!t.done) return t; u = t.value, c < 2 && (c = 0); } else 1 === c && (t = i.return) && t.call(i), c < 2 && (u = TypeError("The iterator does not provide a '" + o + "' method"), c = 1); i = e; } else if ((t = (y = G.n < 0) ? u : r.call(n, G)) !== a) break; } catch (t) { i = e, c = 1, u = t; } finally { f = 1; } } return { value: t, done: y }; }; }(r, o, i), !0), u; } var a = {}; function Generator() {} function GeneratorFunction() {} function GeneratorFunctionPrototype() {} t = Object.getPrototypeOf; var c = [][n] ? t(t([][n]())) : (_regeneratorDefine2(t = {}, n, function () { return this; }), t), u = GeneratorFunctionPrototype.prototype = Generator.prototype = Object.create(c); function f(e) { return Object.setPrototypeOf ? Object.setPrototypeOf(e, GeneratorFunctionPrototype) : (e.__proto__ = GeneratorFunctionPrototype, _regeneratorDefine2(e, o, "GeneratorFunction")), e.prototype = Object.create(u), e; } return GeneratorFunction.prototype = GeneratorFunctionPrototype, _regeneratorDefine2(u, "constructor", GeneratorFunctionPrototype), _regeneratorDefine2(GeneratorFunctionPrototype, "constructor", GeneratorFunction), GeneratorFunction.displayName = "GeneratorFunction", _regeneratorDefine2(GeneratorFunctionPrototype, o, "GeneratorFunction"), _regeneratorDefine2(u), _regeneratorDefine2(u, o, "Generator"), _regeneratorDefine2(u, n, function () { return this; }), _regeneratorDefine2(u, "toString", function () { return "[object Generator]"; }), (_regenerator = function _regenerator() { return { w: i, m: f }; })(); }
function _regeneratorDefine2(e, r, n, t) { var i = Object.defineProperty; try { i({}, "", {}); } catch (e) { i = 0; } _regeneratorDefine2 = function _regeneratorDefine(e, r, n, t) { function o(r, n) { _regeneratorDefine2(e, r, function (e) { return this._invoke(r, n, e); }); } r ? i ? i(e, r, { value: n, enumerable: !t, configurable: !t, writable: !t }) : e[r] = n : (o("next", 0), o("throw", 1), o("return", 2)); }, _regeneratorDefine2(e, r, n, t); }
var supabase = function (e, _Deno$version, _process$version) {
  function t(e, t) {
    var n = {};
    for (var r in e) Object.prototype.hasOwnProperty.call(e, r) && t.indexOf(r) < 0 && (n[r] = e[r]);
    if (e != null && typeof Object.getOwnPropertySymbols == `function`) for (var i = 0, r = Object.getOwnPropertySymbols(e); i < r.length; i++) t.indexOf(r[i]) < 0 && Object.prototype.propertyIsEnumerable.call(e, r[i]) && (n[r[i]] = e[r[i]]);
    return n;
  }
  function n(e, t, n, r) {
    function i(e) {
      return e instanceof n ? e : new n(function (t) {
        t(e);
      });
    }
    return new (n || (n = Promise))(function (n, a) {
      function o(e) {
        try {
          c(r.next(e));
        } catch (e) {
          a(e);
        }
      }
      function s(e) {
        try {
          c(r.throw(e));
        } catch (e) {
          a(e);
        }
      }
      function c(e) {
        e.done ? n(e.value) : i(e.value).then(o, s);
      }
      c((r = r.apply(e, t || [])).next());
    });
  }
  var r = e => e ? (...t) => e(...t) : (...e) => fetch(...e);
  var i = class extends Error {
      constructor(e, t = `FunctionsError`, n) {
        super(e), this.name = t, this.context = n;
      }
      toJSON() {
        return {
          name: this.name,
          message: this.message,
          context: this.context
        };
      }
    },
    a = class extends i {
      constructor(e) {
        super(`Failed to send a request to the Edge Function`, `FunctionsFetchError`, e);
      }
    },
    o = class extends i {
      constructor(e) {
        super(`Relay Error invoking the Edge Function`, `FunctionsRelayError`, e);
      }
    },
    s = class extends i {
      constructor(e) {
        super(`Edge Function returned a non-2xx status code`, `FunctionsHttpError`, e);
      }
    },
    c;
  (function (e) {
    e.Any = `any`, e.ApNortheast1 = `ap-northeast-1`, e.ApNortheast2 = `ap-northeast-2`, e.ApSouth1 = `ap-south-1`, e.ApSoutheast1 = `ap-southeast-1`, e.ApSoutheast2 = `ap-southeast-2`, e.CaCentral1 = `ca-central-1`, e.EuCentral1 = `eu-central-1`, e.EuWest1 = `eu-west-1`, e.EuWest2 = `eu-west-2`, e.EuWest3 = `eu-west-3`, e.SaEast1 = `sa-east-1`, e.UsEast1 = `us-east-1`, e.UsWest1 = `us-west-1`, e.UsWest2 = `us-west-2`;
  })(c || (c = {}));
  var l = class {
    constructor(e, {
      headers: t = {},
      customFetch: n,
      region: i = c.Any
    } = {}) {
      this.url = e, this.headers = t, this.region = i, this.fetch = r(n);
    }
    setAuth(e) {
      this.headers.Authorization = `Bearer ${e}`;
    }
    invoke(e) {
      return n(this, arguments, void 0, /*#__PURE__*/_regenerator().m(function _callee(e, t = {}) {
        var n, r, _g$headers$get, _i2, _c, _l, _u, _d, _f, _p, _m, _h, _ee, _g, _te, _2, _ne, _t2, _t3, _t4, _t5, _t6;
        return _regenerator().w(function (_context) {
          while (1) switch (_context.p = _context.n) {
            case 0:
              _context.p = 0;
              _i2 = t.headers, _c = t.method, _l = t.body, _u = t.signal, _d = t.timeout, _f = {}, _p = t.region;
              _p || (_p = this.region);
              _m = new URL(`${this.url}/${e}`);
              _p && _p !== `any` && (_f[`x-region`] = _p, _m.searchParams.set(`forceFunctionRegion`, _p));
              _l && (_i2 && !Object.prototype.hasOwnProperty.call(_i2, `Content-Type`) || !_i2) ? typeof Blob < `u` && _l instanceof Blob || _l instanceof ArrayBuffer ? (_f[`Content-Type`] = `application/octet-stream`, _h = _l) : typeof _l == `string` ? (_f[`Content-Type`] = `text/plain`, _h = _l) : typeof FormData < `u` && _l instanceof FormData ? _h = _l : (_f[`Content-Type`] = `application/json`, _h = JSON.stringify(_l)) : _h = _l && typeof _l != `string` && !(typeof Blob < `u` && _l instanceof Blob) && !(_l instanceof ArrayBuffer) && !(typeof FormData < `u` && _l instanceof FormData) ? JSON.stringify(_l) : _l;
              _ee = _u;
              _d && (r = new AbortController(), n = setTimeout(() => r.abort(), _d), _u ? (_ee = r.signal, _u.addEventListener(`abort`, () => r.abort())) : _ee = r.signal);
              _context.n = 1;
              return this.fetch(_m.toString(), {
                method: _c || `POST`,
                headers: Object.assign(Object.assign(Object.assign({}, _f), this.headers), _i2),
                body: _h,
                signal: _ee
              }).catch(e => {
                throw new a(e);
              });
            case 1:
              _g = _context.v;
              _te = _g.headers.get(`x-relay-error`);
              if (!(_te && _te === `true`)) {
                _context.n = 2;
                break;
              }
              throw new o(_g);
            case 2:
              if (_g.ok) {
                _context.n = 3;
                break;
              }
              throw new s(_g);
            case 3:
              _2 = ((_g$headers$get = _g.headers.get(`Content-Type`)) !== null && _g$headers$get !== void 0 ? _g$headers$get : `text/plain`).split(`;`)[0].trim();
              if (!(_2 === `application/json`)) {
                _context.n = 5;
                break;
              }
              _context.n = 4;
              return _g.json();
            case 4:
              _t2 = _context.v;
              _context.n = 15;
              break;
            case 5:
              if (!(_2 === `application/octet-stream` || _2 === `application/pdf`)) {
                _context.n = 7;
                break;
              }
              _context.n = 6;
              return _g.blob();
            case 6:
              _t3 = _context.v;
              _context.n = 14;
              break;
            case 7:
              if (!(_2 === `text/event-stream`)) {
                _context.n = 8;
                break;
              }
              _t4 = _g;
              _context.n = 13;
              break;
            case 8:
              if (!(_2 === `multipart/form-data`)) {
                _context.n = 10;
                break;
              }
              _context.n = 9;
              return _g.formData();
            case 9:
              _t5 = _context.v;
              _context.n = 12;
              break;
            case 10:
              _context.n = 11;
              return _g.text();
            case 11:
              _t5 = _context.v;
            case 12:
              _t4 = _t5;
            case 13:
              _t3 = _t4;
            case 14:
              _t2 = _t3;
            case 15:
              _ne = _t2;
              return _context.a(2, {
                data: _ne,
                error: null,
                response: _g
              });
            case 16:
              _context.p = 16;
              _t6 = _context.v;
              return _context.a(2, {
                data: null,
                error: _t6,
                response: _t6 instanceof s || _t6 instanceof o ? _t6.context : void 0
              });
            case 17:
              _context.p = 17;
              n && clearTimeout(n);
              return _context.f(17);
            case 18:
              return _context.a(2);
          }
        }, _callee, this, [[0, 16, 17, 18]]);
      }));
    }
  };
  var u = e => Math.min(1e3 * Math.pow(2, e), 3e4),
    d = [520, 503],
    f = [`GET`, `HEAD`, `OPTIONS`];
  var p = class extends Error {
    constructor(e) {
      super(e.message), this.name = `PostgrestError`, this.details = e.details, this.hint = e.hint, this.code = e.code;
    }
    toJSON() {
      return {
        name: this.name,
        message: this.message,
        details: this.details,
        hint: this.hint,
        code: this.code
      };
    }
  };
  function m(e, t) {
    return new Promise(n => {
      if (t !== null && t !== void 0 && t.aborted) {
        n();
        return;
      }
      var r = setTimeout(() => {
        t !== null && t !== void 0 && t.removeEventListener(`abort`, i), n();
      }, e);
      function i() {
        clearTimeout(r), n();
      }
      t === null || t === void 0 || t.addEventListener(`abort`, i);
    });
  }
  function h(e, t, n, r) {
    return !(!r || n >= 3 || !f.includes(e) || !d.includes(t));
  }
  var ee = class {
      constructor(e) {
        var _e$shouldThrowOnError, _e$isMaybeSingle, _e$shouldStripNulls, _e$urlLengthLimit, _e$retry;
        this.shouldThrowOnError = !1, this.retryEnabled = !0, this.method = e.method, this.url = e.url, this.headers = new Headers(e.headers), this.schema = e.schema, this.body = e.body, this.shouldThrowOnError = (_e$shouldThrowOnError = e.shouldThrowOnError) !== null && _e$shouldThrowOnError !== void 0 ? _e$shouldThrowOnError : !1, this.signal = e.signal, this.isMaybeSingle = (_e$isMaybeSingle = e.isMaybeSingle) !== null && _e$isMaybeSingle !== void 0 ? _e$isMaybeSingle : !1, this.shouldStripNulls = (_e$shouldStripNulls = e.shouldStripNulls) !== null && _e$shouldStripNulls !== void 0 ? _e$shouldStripNulls : !1, this.urlLengthLimit = (_e$urlLengthLimit = e.urlLengthLimit) !== null && _e$urlLengthLimit !== void 0 ? _e$urlLengthLimit : 8e3, this.retryEnabled = (_e$retry = e.retry) !== null && _e$retry !== void 0 ? _e$retry : !0, e.fetch ? this.fetch = e.fetch : this.fetch = fetch;
      }
      throwOnError() {
        return this.shouldThrowOnError = !0, this;
      }
      stripNulls() {
        if (this.headers.get(`Accept`) === `text/csv`) throw Error(`stripNulls() cannot be used with csv()`);
        return this.shouldStripNulls = !0, this;
      }
      setHeader(e, t) {
        return this.headers = new Headers(this.headers), this.headers.set(e, t), this;
      }
      retry(e) {
        return this.retryEnabled = e, this;
      }
      then(e, t) {
        var n = this;
        if (this.schema === void 0 || ([`GET`, `HEAD`].includes(this.method) ? this.headers.set(`Accept-Profile`, this.schema) : this.headers.set(`Content-Profile`, this.schema)), this.method !== `GET` && this.method !== `HEAD` && this.headers.set(`Content-Type`, `application/json`), this.shouldStripNulls) {
          var _e2 = this.headers.get(`Accept`);
          _e2 === `application/vnd.pgrst.object+json` ? this.headers.set(`Accept`, `application/vnd.pgrst.object+json;nulls=stripped`) : (!_e2 || _e2 === `application/json`) && this.headers.set(`Accept`, `application/vnd.pgrst.array+json;nulls=stripped`);
        }
        var r = this.fetch,
          i = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee2() {
            var e, _loop, _ret;
            return _regenerator().w(function (_context3) {
              while (1) switch (_context3.n) {
                case 0:
                  e = 0;
                  _loop = /*#__PURE__*/_regenerator().m(function _loop() {
                    var t, i, _t7, _i$headers$get, _i$headers, _t8, _r2, _t9, _t0;
                    return _regenerator().w(function (_context2) {
                      while (1) switch (_context2.p = _context2.n) {
                        case 0:
                          t = {};
                          n.headers.forEach((e, n) => {
                            t[n] = e;
                          }), e > 0 && (t[`X-Retry-Count`] = String(e));
                          _context2.p = 1;
                          _context2.n = 2;
                          return r(n.url.toString(), {
                            method: n.method,
                            headers: t,
                            body: JSON.stringify(n.body, (e, t) => typeof t == `bigint` ? t.toString() : t),
                            signal: n.signal
                          });
                        case 2:
                          i = _context2.v;
                          _context2.n = 7;
                          break;
                        case 3:
                          _context2.p = 3;
                          _t9 = _context2.v;
                          if (!((_t9 === null || _t9 === void 0 ? void 0 : _t9.name) === `AbortError` || (_t9 === null || _t9 === void 0 ? void 0 : _t9.code) === `ABORT_ERR` || !f.includes(n.method))) {
                            _context2.n = 4;
                            break;
                          }
                          throw _t9;
                        case 4:
                          if (!(n.retryEnabled && e < 3)) {
                            _context2.n = 6;
                            break;
                          }
                          _t7 = u(e);
                          e++;
                          _context2.n = 5;
                          return m(_t7, n.signal);
                        case 5:
                          return _context2.a(2, 0);
                        case 6:
                          throw _t9;
                        case 7:
                          if (!h(n.method, i.status, e, n.retryEnabled)) {
                            _context2.n = 10;
                            break;
                          }
                          _t8 = (_i$headers$get = (_i$headers = i.headers) === null || _i$headers === void 0 ? void 0 : _i$headers.get(`Retry-After`)) !== null && _i$headers$get !== void 0 ? _i$headers$get : null, _r2 = _t8 === null ? u(e) : Math.max(0, parseInt(_t8, 10) || 0) * 1e3;
                          _context2.n = 8;
                          return i.text();
                        case 8:
                          e++;
                          _context2.n = 9;
                          return m(_r2, n.signal);
                        case 9:
                          return _context2.a(2, 0);
                        case 10:
                          _context2.n = 11;
                          return n.processResponse(i);
                        case 11:
                          _t0 = _context2.v;
                          return _context2.a(2, {
                            v: _t0
                          });
                      }
                    }, _loop, null, [[1, 3]]);
                  });
                case 1:
                  return _context3.d(_regeneratorValues(_loop()), 2);
                case 2:
                  _ret = _context3.v;
                  if (!(_ret === 0)) {
                    _context3.n = 3;
                    break;
                  }
                  return _context3.a(3, 4);
                case 3:
                  if (!_ret) {
                    _context3.n = 4;
                    break;
                  }
                  return _context3.a(2, _ret.v);
                case 4:
                  _context3.n = 1;
                  break;
                case 5:
                  return _context3.a(2);
              }
            }, _callee2);
          }))();
        return this.shouldThrowOnError || (i = i.catch(e => {
          var _e$stack, _e$name2;
          var t = ``,
            n = ``,
            r = ``,
            i = e === null || e === void 0 ? void 0 : e.cause;
          if (i) {
            var _i$message, _i$code, _e$name, _i$name;
            var _n2 = (_i$message = i === null || i === void 0 ? void 0 : i.message) !== null && _i$message !== void 0 ? _i$message : ``,
              _r3 = (_i$code = i === null || i === void 0 ? void 0 : i.code) !== null && _i$code !== void 0 ? _i$code : ``;
            t = `${(_e$name = e === null || e === void 0 ? void 0 : e.name) !== null && _e$name !== void 0 ? _e$name : `FetchError`}: ${e === null || e === void 0 ? void 0 : e.message}`, t += `\n\nCaused by: ${(_i$name = i === null || i === void 0 ? void 0 : i.name) !== null && _i$name !== void 0 ? _i$name : `Error`}: ${_n2}`, _r3 && (t += ` (${_r3})`), (i === null || i === void 0 ? void 0 : i.stack) && (t += `\n${i.stack}`);
          } else t = (_e$stack = e === null || e === void 0 ? void 0 : e.stack) !== null && _e$stack !== void 0 ? _e$stack : ``;
          var a = this.url.toString().length;
          return (e === null || e === void 0 ? void 0 : e.name) === `AbortError` || (e === null || e === void 0 ? void 0 : e.code) === `ABORT_ERR` ? (r = ``, n = `Request was aborted (timeout or manual cancellation)`, a > this.urlLengthLimit && (n += `. Note: Your request URL is ${a} characters, which may exceed server limits. If selecting many fields, consider using views. If filtering with large arrays (e.g., .in('id', [many IDs])), consider using an RPC function to pass values server-side.`)) : ((i === null || i === void 0 ? void 0 : i.name) === `HeadersOverflowError` || (i === null || i === void 0 ? void 0 : i.code) === `UND_ERR_HEADERS_OVERFLOW`) && (r = ``, n = `HTTP headers exceeded server limits (typically 16KB)`, a > this.urlLengthLimit && (n += `. Your request URL is ${a} characters. If selecting many fields, consider using views. If filtering with large arrays (e.g., .in('id', [200+ IDs])), consider using an RPC function instead.`)), {
            success: !1,
            error: {
              message: `${(_e$name2 = e === null || e === void 0 ? void 0 : e.name) !== null && _e$name2 !== void 0 ? _e$name2 : `FetchError`}: ${e === null || e === void 0 ? void 0 : e.message}`,
              details: t,
              hint: n,
              code: r
            },
            data: null,
            count: null,
            status: 0,
            statusText: ``
          };
        })), i.then(e, t);
      }
      processResponse(e) {
        var _this = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee3() {
          var t, n, r, i, a, o, _t$headers$get2, _e$headers$get, _t$headers$get, _i3, _s, _c2, _i4, _t1;
          return _regenerator().w(function (_context4) {
            while (1) switch (_context4.p = _context4.n) {
              case 0:
                t = _this;
                n = null, r = null, i = null, a = e.status, o = e.statusText;
                if (!e.ok) {
                  _context4.n = 6;
                  break;
                }
                if (!(t.method !== `HEAD`)) {
                  _context4.n = 5;
                  break;
                }
                _context4.n = 1;
                return e.text();
              case 1:
                _i3 = _context4.v;
                if (!(_i3 !== ``)) {
                  _context4.n = 5;
                  break;
                }
                if (!(t.headers.get(`Accept`) === `text/csv`)) {
                  _context4.n = 2;
                  break;
                }
                r = _i3;
                _context4.n = 5;
                break;
              case 2:
                if (!(t.headers.get(`Accept`) && (_t$headers$get = t.headers.get(`Accept`)) !== null && _t$headers$get !== void 0 && _t$headers$get.includes(`application/vnd.pgrst.plan+text`))) {
                  _context4.n = 3;
                  break;
                }
                r = _i3;
                _context4.n = 5;
                break;
              case 3:
                _context4.p = 3;
                r = JSON.parse(_i3);
                _context4.n = 5;
                break;
              case 4:
                _context4.p = 4;
                _t1 = _context4.v;
                if (!(n = {
                  message: _i3
                }, r = null, t.shouldThrowOnError)) {
                  _context4.n = 5;
                  break;
                }
                throw new p({
                  message: _i3,
                  details: ``,
                  hint: ``,
                  code: ``
                });
              case 5:
                _s = (_t$headers$get2 = t.headers.get(`Prefer`)) === null || _t$headers$get2 === void 0 ? void 0 : _t$headers$get2.match(/count=(exact|planned|estimated)/), _c2 = (_e$headers$get = e.headers.get(`content-range`)) === null || _e$headers$get === void 0 ? void 0 : _e$headers$get.split(`/`);
                _s && _c2 && _c2.length > 1 && (i = parseInt(_c2[1])), t.isMaybeSingle && Array.isArray(r) && (r.length > 1 ? (n = {
                  code: `PGRST116`,
                  details: `Results contain ${r.length} rows, application/vnd.pgrst.object+json requires 1 row`,
                  hint: null,
                  message: `JSON object requested, multiple (or no) rows returned`
                }, r = null, i = null, a = 406, o = `Not Acceptable`) : r = r.length === 1 ? r[0] : null);
                _context4.n = 8;
                break;
              case 6:
                _context4.n = 7;
                return e.text();
              case 7:
                _i4 = _context4.v;
                try {
                  n = JSON.parse(_i4), Array.isArray(n) && e.status === 404 && (r = [], n = null, a = 200, o = `OK`);
                } catch (_unused2) {
                  e.status === 404 && _i4 === `` ? (a = 204, o = `No Content`) : n = {
                    message: _i4
                  };
                }
                if (!(n && t.shouldThrowOnError)) {
                  _context4.n = 8;
                  break;
                }
                throw new p(n);
              case 8:
                return _context4.a(2, {
                  success: n === null,
                  error: n,
                  data: r,
                  count: i,
                  status: a,
                  statusText: o
                });
            }
          }, _callee3, null, [[3, 4]]);
        }))();
      }
      returns() {
        return this;
      }
      overrideTypes() {
        return this;
      }
    },
    g = class extends ee {
      throwOnError() {
        return super.throwOnError();
      }
      select(e) {
        var t = !1,
          n = (e !== null && e !== void 0 ? e : `*`).split(``).map(e => /\s/.test(e) && !t ? `` : (e === `"` && (t = !t), e)).join(``);
        return this.url.searchParams.set(`select`, n), this.headers.append(`Prefer`, `return=representation`), this;
      }
      order(e, {
        ascending: t = !0,
        nullsFirst: n,
        foreignTable: r,
        referencedTable: i = r
      } = {}) {
        var a = i ? `${i}.order` : `order`,
          o = this.url.searchParams.get(a);
        return this.url.searchParams.set(a, `${o ? `${o},` : ``}${e}.${t ? `asc` : `desc`}${n === void 0 ? `` : n ? `.nullsfirst` : `.nullslast`}`), this;
      }
      limit(e, {
        foreignTable: t,
        referencedTable: n = t
      } = {}) {
        var r = n === void 0 ? `limit` : `${n}.limit`;
        return this.url.searchParams.set(r, `${e}`), this;
      }
      range(e, t, {
        foreignTable: n,
        referencedTable: r = n
      } = {}) {
        var i = r === void 0 ? `offset` : `${r}.offset`,
          a = r === void 0 ? `limit` : `${r}.limit`;
        return this.url.searchParams.set(i, `${e}`), this.url.searchParams.set(a, `${t - e + 1}`), this;
      }
      abortSignal(e) {
        return this.signal = e, this;
      }
      single() {
        return this.headers.set(`Accept`, `application/vnd.pgrst.object+json`), this;
      }
      maybeSingle() {
        return this.isMaybeSingle = !0, this;
      }
      csv() {
        return this.headers.set(`Accept`, `text/csv`), this;
      }
      geojson() {
        return this.headers.set(`Accept`, `application/geo+json`), this;
      }
      explain({
        analyze: e = !1,
        verbose: t = !1,
        settings: n = !1,
        buffers: r = !1,
        wal: i = !1,
        format: a = `text`
      } = {}) {
        var _this$headers$get;
        var o = [e ? `analyze` : null, t ? `verbose` : null, n ? `settings` : null, r ? `buffers` : null, i ? `wal` : null].filter(Boolean).join(`|`),
          s = (_this$headers$get = this.headers.get(`Accept`)) !== null && _this$headers$get !== void 0 ? _this$headers$get : `application/json`;
        return this.headers.set(`Accept`, `application/vnd.pgrst.plan+${a}; for="${s}"; options=${o};`), this;
      }
      rollback() {
        return this.headers.append(`Prefer`, `tx=rollback`), this;
      }
      returns() {
        return this;
      }
      maxAffected(e) {
        return this.headers.append(`Prefer`, `handling=strict`), this.headers.append(`Prefer`, `max-affected=${e}`), this;
      }
    };
  var te = RegExp(`[,()]`);
  var _ = class extends g {
      throwOnError() {
        return super.throwOnError();
      }
      eq(e, t) {
        return this.url.searchParams.append(e, `eq.${t}`), this;
      }
      neq(e, t) {
        return this.url.searchParams.append(e, `neq.${t}`), this;
      }
      gt(e, t) {
        return this.url.searchParams.append(e, `gt.${t}`), this;
      }
      gte(e, t) {
        return this.url.searchParams.append(e, `gte.${t}`), this;
      }
      lt(e, t) {
        return this.url.searchParams.append(e, `lt.${t}`), this;
      }
      lte(e, t) {
        return this.url.searchParams.append(e, `lte.${t}`), this;
      }
      like(e, t) {
        return this.url.searchParams.append(e, `like.${t}`), this;
      }
      likeAllOf(e, t) {
        return this.url.searchParams.append(e, `like(all).{${t.join(`,`)}}`), this;
      }
      likeAnyOf(e, t) {
        return this.url.searchParams.append(e, `like(any).{${t.join(`,`)}}`), this;
      }
      ilike(e, t) {
        return this.url.searchParams.append(e, `ilike.${t}`), this;
      }
      ilikeAllOf(e, t) {
        return this.url.searchParams.append(e, `ilike(all).{${t.join(`,`)}}`), this;
      }
      ilikeAnyOf(e, t) {
        return this.url.searchParams.append(e, `ilike(any).{${t.join(`,`)}}`), this;
      }
      regexMatch(e, t) {
        return this.url.searchParams.append(e, `match.${t}`), this;
      }
      regexIMatch(e, t) {
        return this.url.searchParams.append(e, `imatch.${t}`), this;
      }
      is(e, t) {
        return this.url.searchParams.append(e, `is.${t}`), this;
      }
      isDistinct(e, t) {
        return this.url.searchParams.append(e, `isdistinct.${t}`), this;
      }
      in(e, t) {
        var n = Array.from(new Set(t)).map(e => typeof e == `string` && te.test(e) ? `"${e}"` : `${e}`).join(`,`);
        return this.url.searchParams.append(e, `in.(${n})`), this;
      }
      notIn(e, t) {
        var n = Array.from(new Set(t)).map(e => typeof e == `string` && te.test(e) ? `"${e}"` : `${e}`).join(`,`);
        return this.url.searchParams.append(e, `not.in.(${n})`), this;
      }
      contains(e, t) {
        return typeof t == `string` ? this.url.searchParams.append(e, `cs.${t}`) : Array.isArray(t) ? this.url.searchParams.append(e, `cs.{${t.join(`,`)}}`) : this.url.searchParams.append(e, `cs.${JSON.stringify(t)}`), this;
      }
      containedBy(e, t) {
        return typeof t == `string` ? this.url.searchParams.append(e, `cd.${t}`) : Array.isArray(t) ? this.url.searchParams.append(e, `cd.{${t.join(`,`)}}`) : this.url.searchParams.append(e, `cd.${JSON.stringify(t)}`), this;
      }
      rangeGt(e, t) {
        return this.url.searchParams.append(e, `sr.${t}`), this;
      }
      rangeGte(e, t) {
        return this.url.searchParams.append(e, `nxl.${t}`), this;
      }
      rangeLt(e, t) {
        return this.url.searchParams.append(e, `sl.${t}`), this;
      }
      rangeLte(e, t) {
        return this.url.searchParams.append(e, `nxr.${t}`), this;
      }
      rangeAdjacent(e, t) {
        return this.url.searchParams.append(e, `adj.${t}`), this;
      }
      overlaps(e, t) {
        return typeof t == `string` ? this.url.searchParams.append(e, `ov.${t}`) : this.url.searchParams.append(e, `ov.{${t.join(`,`)}}`), this;
      }
      textSearch(e, t, {
        config: n,
        type: r
      } = {}) {
        var i = ``;
        r === `plain` ? i = `pl` : r === `phrase` ? i = `ph` : r === `websearch` && (i = `w`);
        var a = n === void 0 ? `` : `(${n})`;
        return this.url.searchParams.append(e, `${i}fts${a}.${t}`), this;
      }
      match(e) {
        return Object.entries(e).filter(([e, t]) => t !== void 0).forEach(([e, t]) => {
          this.url.searchParams.append(e, `eq.${t}`);
        }), this;
      }
      not(e, t, n) {
        return this.url.searchParams.append(e, `not.${t}.${n}`), this;
      }
      or(e, {
        foreignTable: t,
        referencedTable: n = t
      } = {}) {
        var r = n ? `${n}.or` : `or`;
        return this.url.searchParams.append(r, `(${e})`), this;
      }
      filter(e, t, n) {
        return this.url.searchParams.append(e, `${t}.${n}`), this;
      }
    },
    ne = class {
      constructor(e, {
        headers: t = {},
        schema: n,
        fetch: r,
        urlLengthLimit: i = 8e3,
        retry: a
      }) {
        this.url = e, this.headers = new Headers(t), this.schema = n, this.fetch = r, this.urlLengthLimit = i, this.retry = a;
      }
      cloneRequestState() {
        return {
          url: new URL(this.url.toString()),
          headers: new Headers(this.headers)
        };
      }
      select(e, t) {
        var _ref2 = t !== null && t !== void 0 ? t : {},
          _ref2$head = _ref2.head,
          n = _ref2$head === void 0 ? !1 : _ref2$head,
          r = _ref2.count,
          i = n ? `HEAD` : `GET`,
          a = !1,
          o = (e !== null && e !== void 0 ? e : `*`).split(``).map(e => /\s/.test(e) && !a ? `` : (e === `"` && (a = !a), e)).join(``),
          _this$cloneRequestSta = this.cloneRequestState(),
          s = _this$cloneRequestSta.url,
          c = _this$cloneRequestSta.headers;
        return s.searchParams.set(`select`, o), r && c.append(`Prefer`, `count=${r}`), new _({
          method: i,
          url: s,
          headers: c,
          schema: this.schema,
          fetch: this.fetch,
          urlLengthLimit: this.urlLengthLimit,
          retry: this.retry
        });
      }
      insert(e, {
        count: t,
        defaultToNull: n = !0
      } = {}) {
        var _this$fetch;
        var _this$cloneRequestSta2 = this.cloneRequestState(),
          r = _this$cloneRequestSta2.url,
          i = _this$cloneRequestSta2.headers;
        if (t && i.append(`Prefer`, `count=${t}`), n || i.append(`Prefer`, `missing=default`), Array.isArray(e)) {
          var _t10 = e.reduce((e, t) => e.concat(Object.keys(t)), []);
          if (_t10.length > 0) {
            var _e3 = [...new Set(_t10)].map(e => `"${e}"`);
            r.searchParams.set(`columns`, _e3.join(`,`));
          }
        }
        return new _({
          method: `POST`,
          url: r,
          headers: i,
          schema: this.schema,
          body: e,
          fetch: (_this$fetch = this.fetch) !== null && _this$fetch !== void 0 ? _this$fetch : fetch,
          urlLengthLimit: this.urlLengthLimit,
          retry: this.retry
        });
      }
      upsert(e, {
        onConflict: t,
        ignoreDuplicates: n = !1,
        count: r,
        defaultToNull: i = !0
      } = {}) {
        var _this$fetch2;
        var _this$cloneRequestSta3 = this.cloneRequestState(),
          a = _this$cloneRequestSta3.url,
          o = _this$cloneRequestSta3.headers;
        if (o.append(`Prefer`, `resolution=${n ? `ignore` : `merge`}-duplicates`), t !== void 0 && a.searchParams.set(`on_conflict`, t), r && o.append(`Prefer`, `count=${r}`), i || o.append(`Prefer`, `missing=default`), Array.isArray(e)) {
          var _t11 = e.reduce((e, t) => e.concat(Object.keys(t)), []);
          if (_t11.length > 0) {
            var _e4 = [...new Set(_t11)].map(e => `"${e}"`);
            a.searchParams.set(`columns`, _e4.join(`,`));
          }
        }
        return new _({
          method: `POST`,
          url: a,
          headers: o,
          schema: this.schema,
          body: e,
          fetch: (_this$fetch2 = this.fetch) !== null && _this$fetch2 !== void 0 ? _this$fetch2 : fetch,
          urlLengthLimit: this.urlLengthLimit,
          retry: this.retry
        });
      }
      update(e, {
        count: t
      } = {}) {
        var _this$fetch3;
        var _this$cloneRequestSta4 = this.cloneRequestState(),
          n = _this$cloneRequestSta4.url,
          r = _this$cloneRequestSta4.headers;
        return t && r.append(`Prefer`, `count=${t}`), new _({
          method: `PATCH`,
          url: n,
          headers: r,
          schema: this.schema,
          body: e,
          fetch: (_this$fetch3 = this.fetch) !== null && _this$fetch3 !== void 0 ? _this$fetch3 : fetch,
          urlLengthLimit: this.urlLengthLimit,
          retry: this.retry
        });
      }
      delete({
        count: e
      } = {}) {
        var _this$fetch4;
        var _this$cloneRequestSta5 = this.cloneRequestState(),
          t = _this$cloneRequestSta5.url,
          n = _this$cloneRequestSta5.headers;
        return e && n.append(`Prefer`, `count=${e}`), new _({
          method: `DELETE`,
          url: t,
          headers: n,
          schema: this.schema,
          fetch: (_this$fetch4 = this.fetch) !== null && _this$fetch4 !== void 0 ? _this$fetch4 : fetch,
          urlLengthLimit: this.urlLengthLimit,
          retry: this.retry
        });
      }
    };
  function re(e) {
    "@babel/helpers - typeof";

    return re = typeof Symbol == `function` && typeof Symbol.iterator == `symbol` ? function (e) {
      return typeof e;
    } : function (e) {
      return e && typeof Symbol == `function` && e.constructor === Symbol && e !== Symbol.prototype ? `symbol` : typeof e;
    }, re(e);
  }
  function ie(e, t) {
    if (re(e) != `object` || !e) return e;
    var n = e[Symbol.toPrimitive];
    if (n !== void 0) {
      var r = n.call(e, t || `default`);
      if (re(r) != `object`) return r;
      throw TypeError(`@@toPrimitive must return a primitive value.`);
    }
    return (t === `string` ? String : Number)(e);
  }
  function ae(e) {
    var t = ie(e, `string`);
    return re(t) == `symbol` ? t : t + ``;
  }
  function oe(e, t, n) {
    return (t = ae(t)) in e ? Object.defineProperty(e, t, {
      value: n,
      enumerable: !0,
      configurable: !0,
      writable: !0
    }) : e[t] = n, e;
  }
  function se(e, t) {
    var n = Object.keys(e);
    if (Object.getOwnPropertySymbols) {
      var r = Object.getOwnPropertySymbols(e);
      t && (r = r.filter(function (t) {
        return Object.getOwnPropertyDescriptor(e, t).enumerable;
      })), n.push.apply(n, r);
    }
    return n;
  }
  function ce(e) {
    for (var t = 1; t < arguments.length; t++) {
      var n = arguments[t] == null ? {} : arguments[t];
      t % 2 ? se(Object(n), !0).forEach(function (t) {
        oe(e, t, n[t]);
      }) : Object.getOwnPropertyDescriptors ? Object.defineProperties(e, Object.getOwnPropertyDescriptors(n)) : se(Object(n)).forEach(function (t) {
        Object.defineProperty(e, t, Object.getOwnPropertyDescriptor(n, t));
      });
    }
    return e;
  }
  var le = class e {
      constructor(e, {
        headers: t = {},
        schema: n,
        fetch: r,
        timeout: i,
        urlLengthLimit: a = 8e3,
        retry: o
      } = {}) {
        this.url = e, this.headers = new Headers(t), this.schemaName = n, this.urlLengthLimit = a;
        var s = r !== null && r !== void 0 ? r : globalThis.fetch;
        i !== void 0 && i > 0 ? this.fetch = (e, t) => {
          var n = new AbortController(),
            r = setTimeout(() => n.abort(), i),
            a = t === null || t === void 0 ? void 0 : t.signal;
          if (a) {
            if (a.aborted) return clearTimeout(r), s(e, t);
            var _i5 = () => {
              clearTimeout(r), n.abort();
            };
            return a.addEventListener(`abort`, _i5, {
              once: !0
            }), s(e, ce(ce({}, t), {}, {
              signal: n.signal
            })).finally(() => {
              clearTimeout(r), a.removeEventListener(`abort`, _i5);
            });
          }
          return s(e, ce(ce({}, t), {}, {
            signal: n.signal
          })).finally(() => clearTimeout(r));
        } : this.fetch = s, this.retry = o;
      }
      from(e) {
        if (!e || typeof e != `string` || e.trim() === ``) throw Error(`Invalid relation name: relation must be a non-empty string.`);
        return new ne(new URL(`${this.url}/${e}`), {
          headers: new Headers(this.headers),
          schema: this.schemaName,
          fetch: this.fetch,
          urlLengthLimit: this.urlLengthLimit,
          retry: this.retry
        });
      }
      schema(t) {
        return new e(this.url, {
          headers: this.headers,
          schema: t,
          fetch: this.fetch,
          urlLengthLimit: this.urlLengthLimit,
          retry: this.retry
        });
      }
      rpc(e, t = {}, {
        head: n = !1,
        get: r = !1,
        count: i
      } = {}) {
        var _this$fetch5;
        var a,
          o = new URL(`${this.url}/rpc/${e}`),
          s,
          c = e => typeof e == `object` && !!e && (!Array.isArray(e) || e.some(c)),
          l = n && Object.values(t).some(c);
        l ? (a = `POST`, s = t) : n || r ? (a = n ? `HEAD` : `GET`, Object.entries(t).filter(([e, t]) => t !== void 0).map(([e, t]) => [e, Array.isArray(t) ? `{${t.join(`,`)}}` : `${t}`]).forEach(([e, t]) => {
          o.searchParams.append(e, t);
        })) : (a = `POST`, s = t);
        var u = new Headers(this.headers);
        return l ? u.set(`Prefer`, i ? `count=${i},return=minimal` : `return=minimal`) : i && u.set(`Prefer`, `count=${i}`), new _({
          method: a,
          url: o,
          headers: u,
          schema: this.schemaName,
          body: s,
          fetch: (_this$fetch5 = this.fetch) !== null && _this$fetch5 !== void 0 ? _this$fetch5 : fetch,
          urlLengthLimit: this.urlLengthLimit,
          retry: this.retry
        });
      }
    },
    ue = class {
      constructor() {}
      static detectEnvironment() {
        var _navigator$userAgent;
        if (typeof WebSocket < `u`) return {
          type: `native`,
          wsConstructor: WebSocket
        };
        var e = globalThis;
        if (typeof globalThis < `u` && e.WebSocket !== void 0) return {
          type: `native`,
          wsConstructor: e.WebSocket
        };
        var t = typeof global < `u` ? global : void 0;
        if (t && t.WebSocket !== void 0) return {
          type: `native`,
          wsConstructor: t.WebSocket
        };
        if (typeof globalThis < `u` && e.WebSocketPair !== void 0 && globalThis.WebSocket === void 0) return {
          type: `cloudflare`,
          error: `Cloudflare Workers detected. WebSocket clients are not supported in Cloudflare Workers.`,
          workaround: `Use Cloudflare Workers WebSocket API for server-side WebSocket handling, or deploy to a different runtime.`
        };
        if (typeof globalThis < `u` && e.EdgeRuntime || typeof navigator < `u` && (_navigator$userAgent = navigator.userAgent) !== null && _navigator$userAgent !== void 0 && _navigator$userAgent.includes(`Vercel-Edge`)) return {
          type: `unsupported`,
          error: `Edge runtime detected (Vercel Edge/Netlify Edge). WebSockets are not supported in edge functions.`,
          workaround: `Use serverless functions or a different deployment target for WebSocket functionality.`
        };
        var n = globalThis.process;
        if (n) {
          var _e5 = n.versions;
          if (_e5 && _e5.node) {
            var _t12 = _e5.node,
              _n3 = parseInt(_t12.replace(/^v/, ``).split(`.`)[0]);
            return _n3 >= 22 ? globalThis.WebSocket === void 0 ? {
              type: `unsupported`,
              error: `Node.js ${_n3} detected but native WebSocket not found.`,
              workaround: `Provide a WebSocket implementation via the transport option.`
            } : {
              type: `native`,
              wsConstructor: globalThis.WebSocket
            } : {
              type: `unsupported`,
              error: `Node.js ${_n3} detected without native WebSocket support.`,
              workaround: `For Node.js < 22, install "ws" package and provide it via the transport option:
import ws from "ws"
new RealtimeClient(url, { transport: ws })`
            };
          }
        }
        return {
          type: `unsupported`,
          error: `Unknown JavaScript runtime without WebSocket support.`,
          workaround: `Ensure you're running in a supported environment (browser, Node.js, Deno) or provide a custom WebSocket implementation.`
        };
      }
      static getWebSocketConstructor() {
        var e = this.detectEnvironment();
        if (e.wsConstructor) return e.wsConstructor;
        var t = e.error || `WebSocket not supported in this environment.`;
        throw e.workaround && (t += `\n\nSuggested solution: ${e.workaround}`), Error(t);
      }
      static isWebSocketSupported() {
        try {
          var _e6 = this.detectEnvironment();
          return _e6.type === `native` || _e6.type === `ws`;
        } catch (_unused3) {
          return !1;
        }
      }
    };
  var v = {
      closed: `closed`,
      errored: `errored`,
      joined: `joined`,
      joining: `joining`,
      leaving: `leaving`
    },
    de = {
      close: `phx_close`,
      error: `phx_error`,
      join: `phx_join`,
      reply: `phx_reply`,
      leave: `phx_leave`,
      access_token: `access_token`
    },
    fe = {
      connecting: `connecting`,
      open: `open`,
      closing: `closing`,
      closed: `closed`
    };
  var pe = class {
      constructor(e) {
        this.HEADER_LENGTH = 1, this.USER_BROADCAST_PUSH_META_LENGTH = 6, this.KINDS = {
          userBroadcastPush: 3,
          userBroadcast: 4
        }, this.BINARY_ENCODING = 0, this.JSON_ENCODING = 1, this.BROADCAST_EVENT = `broadcast`, this.allowedMetadataKeys = [], this.allowedMetadataKeys = e !== null && e !== void 0 ? e : [];
      }
      encode(e, t) {
        if (e.event === this.BROADCAST_EVENT && !(e.payload instanceof ArrayBuffer) && typeof e.payload.event == `string`) return t(this._binaryEncodeUserBroadcastPush(e));
        var n = [e.join_ref, e.ref, e.topic, e.event, e.payload];
        return t(JSON.stringify(n));
      }
      _binaryEncodeUserBroadcastPush(e) {
        var _e$payload;
        return this._isArrayBuffer((_e$payload = e.payload) === null || _e$payload === void 0 ? void 0 : _e$payload.payload) ? this._encodeBinaryUserBroadcastPush(e) : this._encodeJsonUserBroadcastPush(e);
      }
      _encodeBinaryUserBroadcastPush(e) {
        var _e$payload$payload, _e$payload2;
        var t = (_e$payload$payload = (_e$payload2 = e.payload) === null || _e$payload2 === void 0 ? void 0 : _e$payload2.payload) !== null && _e$payload$payload !== void 0 ? _e$payload$payload : new ArrayBuffer(0);
        return this._encodeUserBroadcastPush(e, this.BINARY_ENCODING, t);
      }
      _encodeJsonUserBroadcastPush(e) {
        var _e$payload$payload2, _e$payload3;
        var t = (_e$payload$payload2 = (_e$payload3 = e.payload) === null || _e$payload3 === void 0 ? void 0 : _e$payload3.payload) !== null && _e$payload$payload2 !== void 0 ? _e$payload$payload2 : {},
          n = new TextEncoder().encode(JSON.stringify(t)).buffer;
        return this._encodeUserBroadcastPush(e, this.JSON_ENCODING, n);
      }
      _encodeUserBroadcastPush(e, t, n) {
        var _e$ref, _e$join_ref;
        var r = e.topic,
          i = (_e$ref = e.ref) !== null && _e$ref !== void 0 ? _e$ref : ``,
          a = (_e$join_ref = e.join_ref) !== null && _e$join_ref !== void 0 ? _e$join_ref : ``,
          o = e.payload.event,
          s = this.allowedMetadataKeys ? this._pick(e.payload, this.allowedMetadataKeys) : {},
          c = Object.keys(s).length === 0 ? `` : JSON.stringify(s);
        if (a.length > 255) throw Error(`joinRef length ${a.length} exceeds maximum of 255`);
        if (i.length > 255) throw Error(`ref length ${i.length} exceeds maximum of 255`);
        if (r.length > 255) throw Error(`topic length ${r.length} exceeds maximum of 255`);
        if (o.length > 255) throw Error(`userEvent length ${o.length} exceeds maximum of 255`);
        if (c.length > 255) throw Error(`metadata length ${c.length} exceeds maximum of 255`);
        var l = this.USER_BROADCAST_PUSH_META_LENGTH + a.length + i.length + r.length + o.length + c.length,
          u = new ArrayBuffer(this.HEADER_LENGTH + l),
          d = new DataView(u),
          f = 0;
        d.setUint8(f++, this.KINDS.userBroadcastPush), d.setUint8(f++, a.length), d.setUint8(f++, i.length), d.setUint8(f++, r.length), d.setUint8(f++, o.length), d.setUint8(f++, c.length), d.setUint8(f++, t), Array.from(a, e => d.setUint8(f++, e.charCodeAt(0))), Array.from(i, e => d.setUint8(f++, e.charCodeAt(0))), Array.from(r, e => d.setUint8(f++, e.charCodeAt(0))), Array.from(o, e => d.setUint8(f++, e.charCodeAt(0))), Array.from(c, e => d.setUint8(f++, e.charCodeAt(0)));
        var p = new Uint8Array(u.byteLength + n.byteLength);
        return p.set(new Uint8Array(u), 0), p.set(new Uint8Array(n), u.byteLength), p.buffer;
      }
      decode(e, t) {
        if (this._isArrayBuffer(e)) return t(this._binaryDecode(e));
        if (typeof e == `string`) {
          var _JSON$parse = JSON.parse(e),
            _JSON$parse2 = _slicedToArray(_JSON$parse, 5),
            n = _JSON$parse2[0],
            r = _JSON$parse2[1],
            i = _JSON$parse2[2],
            a = _JSON$parse2[3],
            o = _JSON$parse2[4];
          return t({
            join_ref: n,
            ref: r,
            topic: i,
            event: a,
            payload: o
          });
        }
        return t({});
      }
      _binaryDecode(e) {
        var t = new DataView(e),
          n = t.getUint8(0),
          r = new TextDecoder();
        switch (n) {
          case this.KINDS.userBroadcast:
            return this._decodeUserBroadcast(e, t, r);
        }
      }
      _decodeUserBroadcast(e, t, n) {
        var r = t.getUint8(1),
          i = t.getUint8(2),
          a = t.getUint8(3),
          o = t.getUint8(4),
          s = this.HEADER_LENGTH + 4,
          c = n.decode(e.slice(s, s + r));
        s += r;
        var l = n.decode(e.slice(s, s + i));
        s += i;
        var u = n.decode(e.slice(s, s + a));
        s += a;
        var d = e.slice(s, e.byteLength),
          f = o === this.JSON_ENCODING ? JSON.parse(n.decode(d)) : d,
          p = {
            type: this.BROADCAST_EVENT,
            event: l,
            payload: f
          };
        return a > 0 && (p.meta = JSON.parse(u)), {
          join_ref: null,
          ref: null,
          topic: c,
          event: this.BROADCAST_EVENT,
          payload: p
        };
      }
      _isArrayBuffer(e) {
        var _e$constructor;
        return e instanceof ArrayBuffer || (e === null || e === void 0 || (_e$constructor = e.constructor) === null || _e$constructor === void 0 ? void 0 : _e$constructor.name) === `ArrayBuffer`;
      }
      _pick(e, t) {
        return !e || typeof e != `object` ? {} : Object.fromEntries(Object.entries(e).filter(([e]) => t.includes(e)));
      }
    },
    y;
  (function (e) {
    e.abstime = `abstime`, e.bool = `bool`, e.date = `date`, e.daterange = `daterange`, e.float4 = `float4`, e.float8 = `float8`, e.int2 = `int2`, e.int4 = `int4`, e.int4range = `int4range`, e.int8 = `int8`, e.int8range = `int8range`, e.json = `json`, e.jsonb = `jsonb`, e.money = `money`, e.numeric = `numeric`, e.oid = `oid`, e.reltime = `reltime`, e.text = `text`, e.time = `time`, e.timestamp = `timestamp`, e.timestamptz = `timestamptz`, e.timetz = `timetz`, e.tsrange = `tsrange`, e.tstzrange = `tstzrange`;
  })(y || (y = {}));
  var me = (e, t, n = {}) => {
      var _n$skipTypes;
      var r = (_n$skipTypes = n.skipTypes) !== null && _n$skipTypes !== void 0 ? _n$skipTypes : [];
      return t ? Object.keys(t).reduce((n, i) => (n[i] = he(i, e, t, r), n), {}) : {};
    },
    he = (e, t, n, r) => {
      var _t$find;
      var i = (_t$find = t.find(t => t.name === e)) === null || _t$find === void 0 ? void 0 : _t$find.type,
        a = n[e];
      return i && !r.includes(i) ? ge(i, a) : _e(a);
    },
    ge = (e, t) => {
      if (e.charAt(0) === `_`) return xe(t, e.slice(1, e.length));
      switch (e) {
        case y.bool:
          return ve(t);
        case y.float4:
        case y.float8:
        case y.int2:
        case y.int4:
        case y.int8:
        case y.numeric:
        case y.oid:
          return ye(t);
        case y.json:
        case y.jsonb:
          return be(t);
        case y.timestamp:
          return Se(t);
        case y.abstime:
        case y.date:
        case y.daterange:
        case y.int4range:
        case y.int8range:
        case y.money:
        case y.reltime:
        case y.text:
        case y.time:
        case y.timestamptz:
        case y.timetz:
        case y.tsrange:
        case y.tstzrange:
          return _e(t);
        default:
          return _e(t);
      }
    },
    _e = e => e,
    ve = e => {
      switch (e) {
        case `t`:
          return !0;
        case `f`:
          return !1;
        default:
          return e;
      }
    },
    ye = e => {
      if (typeof e == `string`) {
        var t = parseFloat(e);
        if (!Number.isNaN(t)) return t;
      }
      return e;
    },
    be = e => {
      if (typeof e == `string`) try {
        return JSON.parse(e);
      } catch (_unused4) {
        return e;
      }
      return e;
    },
    xe = (e, t) => {
      if (typeof e != `string`) return e;
      var n = e.length - 1,
        r = e[n];
      if (e[0] === `{` && r === `}`) {
        var _r4,
          i = e.slice(1, n);
        try {
          _r4 = JSON.parse(`[` + i + `]`);
        } catch (_unused5) {
          _r4 = i ? i.split(`,`) : [];
        }
        return _r4.map(e => ge(t, e));
      }
      return e;
    },
    Se = e => typeof e == `string` ? e.replace(` `, `T`) : e,
    Ce = e => {
      var t = new URL(e);
      return t.protocol = t.protocol.replace(/^ws/i, `http`), t.pathname = t.pathname.replace(/\/+$/, ``).replace(/\/socket\/websocket$/i, ``).replace(/\/socket$/i, ``).replace(/\/websocket$/i, ``), t.pathname === `` || t.pathname === `/` ? t.pathname = `/api/broadcast` : t.pathname += `/api/broadcast`, t.href;
    };
  var we = e => typeof e == `function` ? e : function () {
      return e;
    },
    Te = typeof self < `u` ? self : null,
    Ee = typeof window < `u` ? window : null,
    b = Te || Ee || globalThis,
    De = `2.0.0`,
    Oe = 1e4,
    ke = 1e3,
    x = {
      connecting: 0,
      open: 1,
      closing: 2,
      closed: 3
    },
    S = {
      closed: `closed`,
      errored: `errored`,
      joined: `joined`,
      joining: `joining`,
      leaving: `leaving`
    },
    C = {
      close: `phx_close`,
      error: `phx_error`,
      join: `phx_join`,
      reply: `phx_reply`,
      leave: `phx_leave`
    },
    Ae = {
      longpoll: `longpoll`,
      websocket: `websocket`
    },
    je = {
      complete: 4
    },
    Me = `base64url.bearer.phx.`,
    Ne = class {
      constructor(e, t, n, r) {
        this.channel = e, this.event = t, this.payload = n || function () {
          return {};
        }, this.receivedResp = null, this.timeout = r, this.timeoutTimer = null, this.recHooks = [], this.sent = !1, this.ref = void 0;
      }
      resend(e) {
        this.timeout = e, this.reset(), this.send();
      }
      send() {
        this.hasReceived(`timeout`) || (this.startTimeout(), this.sent = !0, this.channel.socket.push({
          topic: this.channel.topic,
          event: this.event,
          payload: this.payload(),
          ref: this.ref,
          join_ref: this.channel.joinRef()
        }));
      }
      receive(e, t) {
        return this.hasReceived(e) && t(this.receivedResp.response), this.recHooks.push({
          status: e,
          callback: t
        }), this;
      }
      reset() {
        this.cancelRefEvent(), this.ref = null, this.refEvent = null, this.receivedResp = null, this.sent = !1;
      }
      destroy() {
        this.cancelRefEvent(), this.cancelTimeout();
      }
      matchReceive({
        status: e,
        response: t,
        _ref: n
      }) {
        this.recHooks.filter(t => t.status === e).forEach(e => e.callback(t));
      }
      cancelRefEvent() {
        this.refEvent && this.channel.off(this.refEvent);
      }
      cancelTimeout() {
        clearTimeout(this.timeoutTimer), this.timeoutTimer = null;
      }
      startTimeout() {
        this.timeoutTimer && this.cancelTimeout(), this.ref = this.channel.socket.makeRef(), this.refEvent = this.channel.replyEventName(this.ref), this.channel.on(this.refEvent, e => {
          this.cancelRefEvent(), this.cancelTimeout(), this.receivedResp = e, this.matchReceive(e);
        }), this.timeoutTimer = setTimeout(() => {
          this.trigger(`timeout`, {});
        }, this.timeout);
      }
      hasReceived(e) {
        return this.receivedResp && this.receivedResp.status === e;
      }
      trigger(e, t) {
        this.channel.trigger(this.refEvent, {
          status: e,
          response: t
        });
      }
    },
    Pe = class {
      constructor(e, t) {
        this.callback = e, this.timerCalc = t, this.timer = void 0, this.tries = 0;
      }
      reset() {
        this.tries = 0, clearTimeout(this.timer);
      }
      scheduleTimeout() {
        clearTimeout(this.timer), this.timer = setTimeout(() => {
          this.tries += 1, this.callback();
        }, this.timerCalc(this.tries + 1));
      }
    },
    Fe = class {
      constructor(e, t, n) {
        this.state = S.closed, this.topic = e, this.params = we(t || {}), this.socket = n, this.bindings = [], this.bindingRef = 0, this.timeout = this.socket.timeout, this.joinedOnce = !1, this.joinPush = new Ne(this, C.join, this.params, this.timeout), this.pushBuffer = [], this.stateChangeRefs = [], this.rejoinTimer = new Pe(() => {
          this.socket.isConnected() && this.rejoin();
        }, this.socket.rejoinAfterMs), this.stateChangeRefs.push(this.socket.onError(() => this.rejoinTimer.reset())), this.stateChangeRefs.push(this.socket.onOpen(() => {
          this.rejoinTimer.reset(), this.isErrored() && this.rejoin();
        })), this.joinPush.receive(`ok`, () => {
          this.state = S.joined, this.rejoinTimer.reset(), this.pushBuffer.forEach(e => e.send()), this.pushBuffer = [];
        }), this.joinPush.receive(`error`, e => {
          this.state = S.errored, this.socket.hasLogger() && this.socket.log(`channel`, `error ${this.topic}`, e), this.socket.isConnected() && this.rejoinTimer.scheduleTimeout();
        }), this.onClose(() => {
          this.rejoinTimer.reset(), this.socket.hasLogger() && this.socket.log(`channel`, `close ${this.topic}`), this.state = S.closed, this.socket.remove(this);
        }), this.onError(e => {
          this.socket.hasLogger() && this.socket.log(`channel`, `error ${this.topic}`, e), this.isJoining() && this.joinPush.reset(), this.state = S.errored, this.socket.isConnected() && this.rejoinTimer.scheduleTimeout();
        }), this.joinPush.receive(`timeout`, () => {
          this.socket.hasLogger() && this.socket.log(`channel`, `timeout ${this.topic}`, this.joinPush.timeout), new Ne(this, C.leave, we({}), this.timeout).send(), this.state = S.errored, this.joinPush.reset(), this.socket.isConnected() && this.rejoinTimer.scheduleTimeout();
        }), this.on(C.reply, (e, t) => {
          this.trigger(this.replyEventName(t), e);
        });
      }
      join(e = this.timeout) {
        if (this.joinedOnce) throw Error(`tried to join multiple times. 'join' can only be called a single time per channel instance`);
        return this.timeout = e, this.joinedOnce = !0, this.rejoin(), this.joinPush;
      }
      teardown() {
        this.pushBuffer.forEach(e => e.destroy()), this.pushBuffer = [], this.rejoinTimer.reset(), this.joinPush.destroy(), this.state = S.closed, this.bindings = [];
      }
      onClose(e) {
        this.on(C.close, e);
      }
      onError(e) {
        return this.on(C.error, t => e(t));
      }
      on(e, t) {
        var n = this.bindingRef++;
        return this.bindings.push({
          event: e,
          ref: n,
          callback: t
        }), n;
      }
      off(e, t) {
        this.bindings = this.bindings.filter(n => !(n.event === e && (t === void 0 || t === n.ref)));
      }
      canPush() {
        return this.socket.isConnected() && this.isJoined();
      }
      push(e, t, n = this.timeout) {
        if (t || (t = {}), !this.joinedOnce) throw Error(`tried to push '${e}' to '${this.topic}' before joining. Use channel.join() before pushing events`);
        var r = new Ne(this, e, function () {
          return t;
        }, n);
        return this.canPush() ? r.send() : (r.startTimeout(), this.pushBuffer.push(r)), r;
      }
      leave(e = this.timeout) {
        this.rejoinTimer.reset(), this.joinPush.cancelTimeout(), this.state = S.leaving;
        var t = () => {
            this.socket.hasLogger() && this.socket.log(`channel`, `leave ${this.topic}`), this.trigger(C.close, `leave`);
          },
          n = new Ne(this, C.leave, we({}), e);
        return n.receive(`ok`, () => t()).receive(`timeout`, () => t()), n.send(), this.canPush() || n.trigger(`ok`, {}), n;
      }
      onMessage(e, t, n) {
        return t;
      }
      filterBindings(e, t, n) {
        return !0;
      }
      isMember(e, t, n, r) {
        return this.topic === e ? r && r !== this.joinRef() ? (this.socket.hasLogger() && this.socket.log(`channel`, `dropping outdated message`, {
          topic: e,
          event: t,
          payload: n,
          joinRef: r
        }), !1) : !0 : !1;
      }
      joinRef() {
        return this.joinPush.ref;
      }
      rejoin(e = this.timeout) {
        this.isLeaving() || (this.socket.leaveOpenTopic(this.topic), this.state = S.joining, this.joinPush.resend(e));
      }
      trigger(e, t, n, r) {
        var i = this.onMessage(e, t, n, r);
        if (t && !i) throw Error(`channel onMessage callbacks must return the payload, modified or unmodified`);
        var a = this.bindings.filter(r => r.event === e && this.filterBindings(r, t, n));
        for (var _e7 = 0; _e7 < a.length; _e7++) a[_e7].callback(i, n, r || this.joinRef());
      }
      replyEventName(e) {
        return `chan_reply_${e}`;
      }
      isClosed() {
        return this.state === S.closed;
      }
      isErrored() {
        return this.state === S.errored;
      }
      isJoined() {
        return this.state === S.joined;
      }
      isJoining() {
        return this.state === S.joining;
      }
      isLeaving() {
        return this.state === S.leaving;
      }
    },
    Ie = class {
      static request(e, t, n, r, i, a, o) {
        if (b.XDomainRequest) {
          var _n4 = new b.XDomainRequest();
          return this.xdomainRequest(_n4, e, t, r, i, a, o);
        } else if (b.XMLHttpRequest) {
          var _s2 = new b.XMLHttpRequest();
          return this.xhrRequest(_s2, e, t, n, r, i, a, o);
        } else if (b.fetch && b.AbortController) return this.fetchRequest(e, t, n, r, i, a, o);else throw Error(`No suitable XMLHttpRequest implementation found`);
      }
      static fetchRequest(e, t, n, r, i, a, o) {
        var s = {
            method: e,
            headers: n,
            body: r
          },
          c = null;
        return i && (c = new AbortController(), setTimeout(() => c.abort(), i), s.signal = c.signal), b.fetch(t, s).then(e => e.text()).then(e => this.parseJSON(e)).then(e => o && o(e)).catch(e => {
          e.name === `AbortError` && a ? a() : o && o(null);
        }), c;
      }
      static xdomainRequest(e, t, n, r, i, a, o) {
        return e.timeout = i, e.open(t, n), e.onload = () => {
          var t = this.parseJSON(e.responseText);
          o && o(t);
        }, a && (e.ontimeout = a), e.onprogress = () => {}, e.send(r), e;
      }
      static xhrRequest(e, t, n, r, i, a, o, s) {
        e.open(t, n, !0), e.timeout = a;
        for (var _i6 = 0, _Object$entries = Object.entries(r); _i6 < _Object$entries.length; _i6++) {
          var _Object$entries$_i = _slicedToArray(_Object$entries[_i6], 2),
            _t13 = _Object$entries$_i[0],
            _n5 = _Object$entries$_i[1];
          e.setRequestHeader(_t13, _n5);
        }
        return e.onerror = () => s && s(null), e.onreadystatechange = () => {
          e.readyState === je.complete && s && s(this.parseJSON(e.responseText));
        }, o && (e.ontimeout = o), e.send(i), e;
      }
      static parseJSON(e) {
        if (!e || e === ``) return null;
        try {
          return JSON.parse(e);
        } catch (_unused6) {
          return console && console.log(`failed to parse JSON response`, e), null;
        }
      }
      static serialize(e, t) {
        var n = [];
        for (var r in e) {
          if (!Object.prototype.hasOwnProperty.call(e, r)) continue;
          var i = t ? `${t}[${r}]` : r,
            a = e[r];
          typeof a == `object` ? n.push(this.serialize(a, i)) : n.push(encodeURIComponent(i) + `=` + encodeURIComponent(a));
        }
        return n.join(`&`);
      }
      static appendParams(e, t) {
        return Object.keys(t).length === 0 ? e : `${e}${e.match(/\?/) ? `&` : `?`}${this.serialize(t)}`;
      }
    },
    Le = e => {
      var t = ``,
        n = new Uint8Array(e),
        r = n.byteLength;
      for (var _e8 = 0; _e8 < r; _e8++) t += String.fromCharCode(n[_e8]);
      return btoa(t);
    },
    w = class {
      constructor(e, t) {
        t && t.length === 2 && t[1].startsWith(Me) && (this.authToken = atob(t[1].slice(Me.length))), this.endPoint = null, this.token = null, this.skipHeartbeat = !0, this.reqs = new Set(), this.awaitingBatchAck = !1, this.currentBatch = null, this.currentBatchTimer = null, this.batchBuffer = [], this.onopen = function () {}, this.onerror = function () {}, this.onmessage = function () {}, this.onclose = function () {}, this.pollEndpoint = this.normalizeEndpoint(e), this.readyState = x.connecting, setTimeout(() => this.poll(), 0);
      }
      normalizeEndpoint(e) {
        return e.replace(`ws://`, `http://`).replace(`wss://`, `https://`).replace(RegExp(`(.*)/` + Ae.websocket), `$1/` + Ae.longpoll);
      }
      endpointURL() {
        return Ie.appendParams(this.pollEndpoint, {
          token: this.token
        });
      }
      closeAndRetry(e, t, n) {
        this.close(e, t, n), this.readyState = x.connecting;
      }
      ontimeout() {
        this.onerror(`timeout`), this.closeAndRetry(1005, `timeout`, !1);
      }
      isActive() {
        return this.readyState === x.open || this.readyState === x.connecting;
      }
      poll() {
        var e = {
          Accept: `application/json`
        };
        this.authToken && (e[`X-Phoenix-AuthToken`] = this.authToken), this.ajax(`GET`, e, null, () => this.ontimeout(), e => {
          if (e) {
            var t = e.status,
              n = e.token,
              r = e.messages;
            if (t === 410 && this.token !== null) {
              this.onerror(410), this.closeAndRetry(3410, `session_gone`, !1);
              return;
            }
            this.token = n;
          } else t = 0;
          switch (t) {
            case 200:
              r.forEach(e => {
                setTimeout(() => this.onmessage({
                  data: e
                }), 0);
              }), this.poll();
              break;
            case 204:
              this.poll();
              break;
            case 410:
              this.readyState = x.open, this.onopen({}), this.poll();
              break;
            case 403:
              this.onerror(403), this.close(1008, `forbidden`, !1);
              break;
            case 0:
            case 500:
              this.onerror(500), this.closeAndRetry(1011, `internal server error`, 500);
              break;
            default:
              throw Error(`unhandled poll status ${t}`);
          }
        });
      }
      send(e) {
        typeof e != `string` && (e = Le(e)), this.currentBatch ? this.currentBatch.push(e) : this.awaitingBatchAck ? this.batchBuffer.push(e) : (this.currentBatch = [e], this.currentBatchTimer = setTimeout(() => {
          this.batchSend(this.currentBatch), this.currentBatch = null;
        }, 0));
      }
      batchSend(e) {
        this.awaitingBatchAck = !0, this.ajax(`POST`, {
          "Content-Type": `application/x-ndjson`
        }, e.join(`
`), () => this.onerror(`timeout`), e => {
          this.awaitingBatchAck = !1, !e || e.status !== 200 ? (this.onerror(e && e.status), this.closeAndRetry(1011, `internal server error`, !1)) : this.batchBuffer.length > 0 && (this.batchSend(this.batchBuffer), this.batchBuffer = []);
        });
      }
      close(e, t, n) {
        var _iterator = _createForOfIteratorHelper(this.reqs),
          _step;
        try {
          for (_iterator.s(); !(_step = _iterator.n()).done;) {
            var _e9 = _step.value;
            _e9.abort();
          }
        } catch (err) {
          _iterator.e(err);
        } finally {
          _iterator.f();
        }
        this.readyState = x.closed;
        var r = Object.assign({
          code: 1e3,
          reason: void 0,
          wasClean: !0
        }, {
          code: e,
          reason: t,
          wasClean: n
        });
        this.batchBuffer = [], clearTimeout(this.currentBatchTimer), this.currentBatchTimer = null, typeof CloseEvent < `u` ? this.onclose(new CloseEvent(`close`, r)) : this.onclose(r);
      }
      ajax(e, t, n, r, i) {
        var a;
        a = Ie.request(e, this.endpointURL(), t, n, this.timeout, () => {
          this.reqs.delete(a), r();
        }, e => {
          this.reqs.delete(a), this.isActive() && i(e);
        }), this.reqs.add(a);
      }
    },
    Re = class e {
      constructor(t, n = {}) {
        var r = n.events || {
          state: `presence_state`,
          diff: `presence_diff`
        };
        this.state = {}, this.pendingDiffs = [], this.channel = t, this.joinRef = null, this.caller = {
          onJoin: function onJoin() {},
          onLeave: function onLeave() {},
          onSync: function onSync() {}
        }, this.channel.on(r.state, t => {
          var _this$caller = this.caller,
            n = _this$caller.onJoin,
            r = _this$caller.onLeave,
            i = _this$caller.onSync;
          this.joinRef = this.channel.joinRef(), this.state = e.syncState(this.state, t, n, r), this.pendingDiffs.forEach(t => {
            this.state = e.syncDiff(this.state, t, n, r);
          }), this.pendingDiffs = [], i();
        }), this.channel.on(r.diff, t => {
          var _this$caller2 = this.caller,
            n = _this$caller2.onJoin,
            r = _this$caller2.onLeave,
            i = _this$caller2.onSync;
          this.inPendingSyncState() ? this.pendingDiffs.push(t) : (this.state = e.syncDiff(this.state, t, n, r), i());
        });
      }
      onJoin(e) {
        this.caller.onJoin = e;
      }
      onLeave(e) {
        this.caller.onLeave = e;
      }
      onSync(e) {
        this.caller.onSync = e;
      }
      list(t) {
        return e.list(this.state, t);
      }
      inPendingSyncState() {
        return !this.joinRef || this.joinRef !== this.channel.joinRef();
      }
      static syncState(e, t, n, r) {
        var i = this.clone(e),
          a = {},
          o = {};
        return this.map(i, (e, n) => {
          t[e] || (o[e] = n);
        }), this.map(t, (e, t) => {
          var n = i[e];
          if (n) {
            var _r5 = t.metas.map(e => e.phx_ref),
              _i7 = n.metas.map(e => e.phx_ref),
              _s3 = t.metas.filter(e => _i7.indexOf(e.phx_ref) < 0),
              _c3 = n.metas.filter(e => _r5.indexOf(e.phx_ref) < 0);
            _s3.length > 0 && (a[e] = t, a[e].metas = _s3), _c3.length > 0 && (o[e] = this.clone(n), o[e].metas = _c3);
          } else a[e] = t;
        }), this.syncDiff(i, {
          joins: a,
          leaves: o
        }, n, r);
      }
      static syncDiff(e, t, n, r) {
        var _this$clone = this.clone(t),
          i = _this$clone.joins,
          a = _this$clone.leaves;
        return n || (n = function n() {}), r || (r = function r() {}), this.map(i, (t, r) => {
          var i = e[t];
          if (e[t] = this.clone(r), i) {
            var _n6 = e[t].metas.map(e => e.phx_ref),
              _r6 = i.metas.filter(e => _n6.indexOf(e.phx_ref) < 0);
            e[t].metas.unshift(..._r6);
          }
          n(t, i, r);
        }), this.map(a, (t, n) => {
          var i = e[t];
          if (!i) return;
          var a = n.metas.map(e => e.phx_ref);
          i.metas = i.metas.filter(e => a.indexOf(e.phx_ref) < 0), r(t, i, n), i.metas.length === 0 && delete e[t];
        }), e;
      }
      static list(e, t) {
        return t || (t = function t(e, _t14) {
          return _t14;
        }), this.map(e, (e, n) => t(e, n));
      }
      static map(e, t) {
        return Object.getOwnPropertyNames(e).map(n => t(n, e[n]));
      }
      static clone(e) {
        return JSON.parse(JSON.stringify(e));
      }
    },
    ze = {
      HEADER_LENGTH: 1,
      META_LENGTH: 4,
      KINDS: {
        push: 0,
        reply: 1,
        broadcast: 2
      },
      encode(e, t) {
        if (e.payload.constructor === ArrayBuffer) return t(this.binaryEncode(e));
        {
          var n = [e.join_ref, e.ref, e.topic, e.event, e.payload];
          return t(JSON.stringify(n));
        }
      },
      decode(e, t) {
        if (e.constructor === ArrayBuffer) return t(this.binaryDecode(e));
        {
          var _JSON$parse3 = JSON.parse(e),
            _JSON$parse4 = _slicedToArray(_JSON$parse3, 5),
            n = _JSON$parse4[0],
            r = _JSON$parse4[1],
            i = _JSON$parse4[2],
            a = _JSON$parse4[3],
            o = _JSON$parse4[4];
          return t({
            join_ref: n,
            ref: r,
            topic: i,
            event: a,
            payload: o
          });
        }
      },
      binaryEncode(e) {
        var t = e.join_ref,
          n = e.ref,
          r = e.event,
          i = e.topic,
          a = e.payload,
          o = this.META_LENGTH + t.length + n.length + i.length + r.length,
          s = new ArrayBuffer(this.HEADER_LENGTH + o),
          c = new DataView(s),
          l = 0;
        c.setUint8(l++, this.KINDS.push), c.setUint8(l++, t.length), c.setUint8(l++, n.length), c.setUint8(l++, i.length), c.setUint8(l++, r.length), Array.from(t, e => c.setUint8(l++, e.charCodeAt(0))), Array.from(n, e => c.setUint8(l++, e.charCodeAt(0))), Array.from(i, e => c.setUint8(l++, e.charCodeAt(0))), Array.from(r, e => c.setUint8(l++, e.charCodeAt(0)));
        var u = new Uint8Array(s.byteLength + a.byteLength);
        return u.set(new Uint8Array(s), 0), u.set(new Uint8Array(a), s.byteLength), u.buffer;
      },
      binaryDecode(e) {
        var t = new DataView(e),
          n = t.getUint8(0),
          r = new TextDecoder();
        switch (n) {
          case this.KINDS.push:
            return this.decodePush(e, t, r);
          case this.KINDS.reply:
            return this.decodeReply(e, t, r);
          case this.KINDS.broadcast:
            return this.decodeBroadcast(e, t, r);
        }
      },
      decodePush(e, t, n) {
        var r = t.getUint8(1),
          i = t.getUint8(2),
          a = t.getUint8(3),
          o = this.HEADER_LENGTH + this.META_LENGTH - 1,
          s = n.decode(e.slice(o, o + r));
        o += r;
        var c = n.decode(e.slice(o, o + i));
        o += i;
        var l = n.decode(e.slice(o, o + a));
        return o += a, {
          join_ref: s,
          ref: null,
          topic: c,
          event: l,
          payload: e.slice(o, e.byteLength)
        };
      },
      decodeReply(e, t, n) {
        var r = t.getUint8(1),
          i = t.getUint8(2),
          a = t.getUint8(3),
          o = t.getUint8(4),
          s = this.HEADER_LENGTH + this.META_LENGTH,
          c = n.decode(e.slice(s, s + r));
        s += r;
        var l = n.decode(e.slice(s, s + i));
        s += i;
        var u = n.decode(e.slice(s, s + a));
        s += a;
        var d = n.decode(e.slice(s, s + o));
        s += o;
        var f = {
          status: d,
          response: e.slice(s, e.byteLength)
        };
        return {
          join_ref: c,
          ref: l,
          topic: u,
          event: C.reply,
          payload: f
        };
      },
      decodeBroadcast(e, t, n) {
        var r = t.getUint8(1),
          i = t.getUint8(2),
          a = this.HEADER_LENGTH + 2,
          o = n.decode(e.slice(a, a + r));
        a += r;
        var s = n.decode(e.slice(a, a + i));
        return a += i, {
          join_ref: null,
          ref: null,
          topic: o,
          event: s,
          payload: e.slice(a, e.byteLength)
        };
      }
    },
    Be = class {
      constructor(e, t = {}) {
        var _t$autoSendHeartbeat,
          _t$heartbeatCallback,
          _this2 = this;
        this.stateChangeCallbacks = {
          open: [],
          close: [],
          error: [],
          message: []
        }, this.channels = [], this.sendBuffer = [], this.ref = 0, this.fallbackRef = null, this.timeout = t.timeout || Oe, this.transport = t.transport || b.WebSocket || w, this.conn = void 0, this.primaryPassedHealthCheck = !1, this.longPollFallbackMs = t.longPollFallbackMs, this.fallbackTimer = null;
        var n = null;
        try {
          n = b && b.sessionStorage;
        } catch (_unused7) {}
        this.sessionStore = t.sessionStorage || n, this.establishedConnections = 0, this.defaultEncoder = ze.encode.bind(ze), this.defaultDecoder = ze.decode.bind(ze), this.closeWasClean = !0, this.disconnecting = !1, this.binaryType = t.binaryType || `arraybuffer`, this.connectClock = 1, this.pageHidden = !1, this.encode = void 0, this.decode = void 0, this.transport === w ? (this.encode = this.defaultEncoder, this.decode = this.defaultDecoder) : (this.encode = t.encode || this.defaultEncoder, this.decode = t.decode || this.defaultDecoder);
        var r = null;
        Ee && Ee.addEventListener && (Ee.addEventListener(`pagehide`, e => {
          this.conn && (this.disconnect(), r = this.connectClock);
        }), Ee.addEventListener(`pageshow`, e => {
          r === this.connectClock && (r = null, this.connect());
        }), Ee.addEventListener(`visibilitychange`, () => {
          document.visibilityState === `hidden` ? this.pageHidden = !0 : (this.pageHidden = !1, !this.isConnected() && !this.closeWasClean && this.teardown(() => this.connect()));
        })), this.heartbeatIntervalMs = t.heartbeatIntervalMs || 3e4, this.autoSendHeartbeat = (_t$autoSendHeartbeat = t.autoSendHeartbeat) !== null && _t$autoSendHeartbeat !== void 0 ? _t$autoSendHeartbeat : !0, this.heartbeatCallback = (_t$heartbeatCallback = t.heartbeatCallback) !== null && _t$heartbeatCallback !== void 0 ? _t$heartbeatCallback : () => {}, this.rejoinAfterMs = e => t.rejoinAfterMs ? t.rejoinAfterMs(e) : [1e3, 2e3, 5e3][e - 1] || 1e4, this.reconnectAfterMs = e => t.reconnectAfterMs ? t.reconnectAfterMs(e) : [10, 50, 100, 150, 200, 250, 500, 1e3, 2e3][e - 1] || 5e3, this.logger = t.logger || null, !this.logger && t.debug && (this.logger = (e, t, n) => {
          console.log(`${e}: ${t}`, n);
        }), this.longpollerTimeout = t.longpollerTimeout || 2e4, this.params = we(t.params || {}), this.endPoint = `${e}/${Ae.websocket}`, this.vsn = t.vsn || De, this.heartbeatTimeoutTimer = null, this.heartbeatTimer = null, this.heartbeatSentAt = null, this.pendingHeartbeatRef = null, this.reconnectTimer = new Pe(() => {
          if (this.pageHidden) {
            this.log(`Not reconnecting as page is hidden!`), this.teardown();
            return;
          }
          this.teardown(/*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee4() {
            var _t15;
            return _regenerator().w(function (_context5) {
              while (1) switch (_context5.n) {
                case 0:
                  _t15 = t.beforeReconnect;
                  if (!_t15) {
                    _context5.n = 1;
                    break;
                  }
                  _context5.n = 1;
                  return t.beforeReconnect();
                case 1:
                  _this2.connect();
                case 2:
                  return _context5.a(2);
              }
            }, _callee4);
          })));
        }, this.reconnectAfterMs), this.authToken = t.authToken;
      }
      getLongPollTransport() {
        return w;
      }
      replaceTransport(e) {
        this.connectClock++, this.closeWasClean = !0, clearTimeout(this.fallbackTimer), this.reconnectTimer.reset(), this.conn && (this.conn = (this.conn.close(), null)), this.transport = e;
      }
      protocol() {
        return location.protocol.match(/^https/) ? `wss` : `ws`;
      }
      endPointURL() {
        var e = Ie.appendParams(Ie.appendParams(this.endPoint, this.params()), {
          vsn: this.vsn
        });
        return e.charAt(0) === `/` ? e.charAt(1) === `/` ? `${this.protocol()}:${e}` : `${this.protocol()}://${location.host}${e}` : e;
      }
      disconnect(e, t, n) {
        this.connectClock++, this.disconnecting = !0, this.closeWasClean = !0, clearTimeout(this.fallbackTimer), this.reconnectTimer.reset(), this.teardown(() => {
          this.disconnecting = !1, e && e();
        }, t, n);
      }
      connect(e) {
        e && (console && console.log(`passing params to connect is deprecated. Instead pass :params to the Socket constructor`), this.params = we(e)), !(this.conn && !this.disconnecting) && (this.longPollFallbackMs && this.transport !== w ? this.connectWithFallback(w, this.longPollFallbackMs) : this.transportConnect());
      }
      log(e, t, n) {
        this.logger && this.logger(e, t, n);
      }
      hasLogger() {
        return this.logger !== null;
      }
      onOpen(e) {
        var t = this.makeRef();
        return this.stateChangeCallbacks.open.push([t, e]), t;
      }
      onClose(e) {
        var t = this.makeRef();
        return this.stateChangeCallbacks.close.push([t, e]), t;
      }
      onError(e) {
        var t = this.makeRef();
        return this.stateChangeCallbacks.error.push([t, e]), t;
      }
      onMessage(e) {
        var t = this.makeRef();
        return this.stateChangeCallbacks.message.push([t, e]), t;
      }
      onHeartbeat(e) {
        this.heartbeatCallback = e;
      }
      ping(e) {
        if (!this.isConnected()) return !1;
        var t = this.makeRef(),
          n = Date.now();
        this.push({
          topic: `phoenix`,
          event: `heartbeat`,
          payload: {},
          ref: t
        });
        var r = this.onMessage(i => {
          i.ref === t && (this.off([r]), e(Date.now() - n));
        });
        return !0;
      }
      transportName(e) {
        switch (e) {
          case w:
            return `LongPoll`;
          default:
            return e.name;
        }
      }
      transportConnect() {
        this.connectClock++, this.closeWasClean = !1;
        var e;
        this.authToken && (e = [`phoenix`, `${Me}${btoa(this.authToken).replace(/=/g, ``)}`]), this.conn = new this.transport(this.endPointURL(), e), this.conn.binaryType = this.binaryType, this.conn.timeout = this.longpollerTimeout, this.conn.onopen = () => this.onConnOpen(), this.conn.onerror = e => this.onConnError(e), this.conn.onmessage = e => this.onConnMessage(e), this.conn.onclose = e => this.onConnClose(e);
      }
      getSession(e) {
        return this.sessionStore && this.sessionStore.getItem(e);
      }
      storeSession(e, t) {
        this.sessionStore && this.sessionStore.setItem(e, t);
      }
      connectWithFallback(e, t = 2500) {
        clearTimeout(this.fallbackTimer);
        var n = !1,
          r = !0,
          i,
          a = this.transportName(e),
          o = t => {
            this.log(`transport`, `falling back to ${a}...`, t), this.off([void 0, i]), r = !1, this.replaceTransport(e), this.transportConnect();
          };
        if (this.getSession(`phx:fallback:${a}`)) return o(`memorized`);
        this.fallbackTimer = setTimeout(o, t), i = this.onError(e => {
          this.log(`transport`, `error`, e), r && !n && (clearTimeout(this.fallbackTimer), o(e));
        }), this.fallbackRef && this.off([this.fallbackRef]), this.fallbackRef = this.onOpen(() => {
          if (n = !0, !r) {
            var _t16 = this.transportName(e);
            return this.primaryPassedHealthCheck || this.storeSession(`phx:fallback:${_t16}`, `true`), this.log(`transport`, `established ${_t16} fallback`);
          }
          clearTimeout(this.fallbackTimer), this.fallbackTimer = setTimeout(o, t), this.ping(e => {
            this.log(`transport`, `connected to primary after`, e), this.primaryPassedHealthCheck = !0, clearTimeout(this.fallbackTimer);
          });
        }), this.transportConnect();
      }
      clearHeartbeats() {
        clearTimeout(this.heartbeatTimer), clearTimeout(this.heartbeatTimeoutTimer);
      }
      onConnOpen() {
        this.hasLogger() && this.log(`transport`, `connected to ${this.endPointURL()}`), this.closeWasClean = !1, this.disconnecting = !1, this.establishedConnections++, this.flushSendBuffer(), this.reconnectTimer.reset(), this.autoSendHeartbeat && this.resetHeartbeat(), this.triggerStateCallbacks(`open`);
      }
      heartbeatTimeout() {
        if (this.pendingHeartbeatRef) {
          this.pendingHeartbeatRef = null, this.heartbeatSentAt = null, this.hasLogger() && this.log(`transport`, `heartbeat timeout. Attempting to re-establish connection`);
          try {
            this.heartbeatCallback(`timeout`);
          } catch (e) {
            this.log(`error`, `error in heartbeat callback`, e);
          }
          this.triggerChanError(Error(`heartbeat timeout`)), this.closeWasClean = !1, this.teardown(() => this.reconnectTimer.scheduleTimeout(), ke, `heartbeat timeout`);
        }
      }
      resetHeartbeat() {
        this.conn && this.conn.skipHeartbeat || (this.pendingHeartbeatRef = null, this.clearHeartbeats(), this.heartbeatTimer = setTimeout(() => this.sendHeartbeat(), this.heartbeatIntervalMs));
      }
      teardown(e, t, n) {
        if (!this.conn) return e && e();
        var r = this.conn;
        this.waitForBufferDone(r, () => {
          t ? r.close(t, n || ``) : r.close(), this.waitForSocketClosed(r, () => {
            this.conn === r && (this.conn.onopen = function () {}, this.conn.onerror = function () {}, this.conn.onmessage = function () {}, this.conn.onclose = function () {}, this.conn = null), e && e();
          });
        });
      }
      waitForBufferDone(e, t, n = 1) {
        if (n === 5 || !e.bufferedAmount) {
          t();
          return;
        }
        setTimeout(() => {
          this.waitForBufferDone(e, t, n + 1);
        }, 150 * n);
      }
      waitForSocketClosed(e, t, n = 1) {
        if (n === 5 || e.readyState === x.closed) {
          t();
          return;
        }
        setTimeout(() => {
          this.waitForSocketClosed(e, t, n + 1);
        }, 150 * n);
      }
      onConnClose(e) {
        this.conn && (this.conn.onclose = () => {}), this.hasLogger() && this.log(`transport`, `close`, e), this.triggerChanError(e), this.clearHeartbeats(), this.closeWasClean || this.reconnectTimer.scheduleTimeout(), this.triggerStateCallbacks(`close`, e);
      }
      onConnError(e) {
        this.hasLogger() && this.log(`transport`, `error`, e);
        var t = this.transport,
          n = this.establishedConnections;
        this.triggerStateCallbacks(`error`, e, t, n), (t === this.transport || n > 0) && this.triggerChanError(e);
      }
      triggerChanError(e) {
        this.channels.forEach(t => {
          t.isErrored() || t.isLeaving() || t.isClosed() || t.trigger(C.error, e);
        });
      }
      connectionState() {
        switch (this.conn && this.conn.readyState) {
          case x.connecting:
            return `connecting`;
          case x.open:
            return `open`;
          case x.closing:
            return `closing`;
          default:
            return `closed`;
        }
      }
      isConnected() {
        return this.connectionState() === `open`;
      }
      remove(e) {
        this.off(e.stateChangeRefs), this.channels = this.channels.filter(t => t !== e);
      }
      off(e) {
        for (var t in this.stateChangeCallbacks) this.stateChangeCallbacks[t] = this.stateChangeCallbacks[t].filter(([t]) => e.indexOf(t) === -1);
      }
      channel(e, t = {}) {
        var n = new Fe(e, t, this);
        return this.channels.push(n), n;
      }
      push(e) {
        if (this.hasLogger()) {
          var t = e.topic,
            n = e.event,
            r = e.payload,
            i = e.ref,
            a = e.join_ref;
          this.log(`push`, `${t} ${n} (${a}, ${i})`, r);
        }
        this.isConnected() ? this.encode(e, e => this.conn.send(e)) : this.sendBuffer.push(() => this.encode(e, e => this.conn.send(e)));
      }
      makeRef() {
        var e = this.ref + 1;
        return e === this.ref ? this.ref = 0 : this.ref = e, this.ref.toString();
      }
      sendHeartbeat() {
        if (!this.isConnected()) {
          try {
            this.heartbeatCallback(`disconnected`);
          } catch (e) {
            this.log(`error`, `error in heartbeat callback`, e);
          }
          return;
        }
        if (this.pendingHeartbeatRef) {
          this.heartbeatTimeout();
          return;
        }
        this.pendingHeartbeatRef = this.makeRef(), this.heartbeatSentAt = Date.now(), this.push({
          topic: `phoenix`,
          event: `heartbeat`,
          payload: {},
          ref: this.pendingHeartbeatRef
        });
        try {
          this.heartbeatCallback(`sent`);
        } catch (e) {
          this.log(`error`, `error in heartbeat callback`, e);
        }
        this.heartbeatTimeoutTimer = setTimeout(() => this.heartbeatTimeout(), this.heartbeatIntervalMs);
      }
      flushSendBuffer() {
        this.isConnected() && this.sendBuffer.length > 0 && (this.sendBuffer.forEach(e => e()), this.sendBuffer = []);
      }
      onConnMessage(e) {
        this.decode(e.data, e => {
          var t = e.topic,
            n = e.event,
            r = e.payload,
            i = e.ref,
            a = e.join_ref;
          if (i && i === this.pendingHeartbeatRef) {
            var _e0 = this.heartbeatSentAt ? Date.now() - this.heartbeatSentAt : void 0;
            this.clearHeartbeats();
            try {
              this.heartbeatCallback(r.status === `ok` ? `ok` : `error`, _e0);
            } catch (e) {
              this.log(`error`, `error in heartbeat callback`, e);
            }
            this.pendingHeartbeatRef = null, this.heartbeatSentAt = null, this.autoSendHeartbeat && (this.heartbeatTimer = setTimeout(() => this.sendHeartbeat(), this.heartbeatIntervalMs));
          }
          this.hasLogger() && this.log(`receive`, `${r.status || ``} ${t} ${n} ${i && `(` + i + `)` || ``}`.trim(), r);
          for (var _e1 = 0; _e1 < this.channels.length; _e1++) {
            var o = this.channels[_e1];
            o.isMember(t, n, r, a) && o.trigger(n, r, i, a);
          }
          this.triggerStateCallbacks(`message`, e);
        });
      }
      triggerStateCallbacks(e, ...t) {
        try {
          this.stateChangeCallbacks[e].forEach(([n, r]) => {
            try {
              r(...t);
            } catch (t) {
              this.log(`error`, `error in ${e} callback`, t);
            }
          });
        } catch (t) {
          this.log(`error`, `error triggering ${e} callbacks`, t);
        }
      }
      leaveOpenTopic(e) {
        var t = this.channels.find(t => t.topic === e && (t.isJoined() || t.isJoining()));
        t && (this.hasLogger() && this.log(`transport`, `leaving duplicate topic "${e}"`), t.leave());
      }
    },
    Ve = class e {
      constructor(t, n) {
        var r = We(n);
        this.presence = new Re(t.getChannel(), r), this.presence.onJoin((n, r, i) => {
          var a = e.onJoinPayload(n, r, i);
          t.getChannel().trigger(`presence`, a);
        }), this.presence.onLeave((n, r, i) => {
          var a = e.onLeavePayload(n, r, i);
          t.getChannel().trigger(`presence`, a);
        }), this.presence.onSync(() => {
          t.getChannel().trigger(`presence`, {
            event: `sync`
          });
        });
      }
      get state() {
        return e.transformState(this.presence.state);
      }
      static transformState(e) {
        return e = Ue(e), Object.getOwnPropertyNames(e).reduce((t, n) => {
          var r = e[n];
          return t[n] = He(r), t;
        }, {});
      }
      static onJoinPayload(e, t, n) {
        return {
          event: `join`,
          key: e,
          currentPresences: Ge(t),
          newPresences: He(n)
        };
      }
      static onLeavePayload(e, t, n) {
        return {
          event: `leave`,
          key: e,
          currentPresences: Ge(t),
          leftPresences: He(n)
        };
      }
    };
  function He(e) {
    return e.metas.map(e => (e.presence_ref = e.phx_ref, delete e.phx_ref, delete e.phx_ref_prev, e));
  }
  function Ue(e) {
    return JSON.parse(JSON.stringify(e));
  }
  function We(e) {
    return (e === null || e === void 0 ? void 0 : e.events) && {
      events: e.events
    };
  }
  function Ge(e) {
    return e !== null && e !== void 0 && e.metas ? He(e) : [];
  }
  var Ke;
  (function (e) {
    e.SYNC = `sync`, e.JOIN = `join`, e.LEAVE = `leave`;
  })(Ke || (Ke = {}));
  var qe = class {
    get state() {
      return this.presenceAdapter.state;
    }
    constructor(e, t) {
      this.channel = e, this.presenceAdapter = new Ve(this.channel.channelAdapter, t);
    }
  };
  function Je(e) {
    if (e instanceof Error) return e;
    if (typeof e == `string`) return Error(e);
    if (e && typeof e == `object`) {
      var t = e;
      if (typeof t.code == `number`) {
        var n = typeof t.reason == `string` && t.reason ? ` (${t.reason})` : ``;
        return Error(`socket closed: ${t.code}${n}`, {
          cause: e
        });
      }
      return Error(`channel error: transport failure`, {
        cause: e
      });
    }
    return Error(`channel error: connection lost`);
  }
  var Ye = class {
    constructor(e, t, n) {
      var r = Xe(n);
      this.channel = e.getSocket().channel(t, r), this.socket = e;
    }
    get state() {
      return this.channel.state;
    }
    set state(e) {
      this.channel.state = e;
    }
    get joinedOnce() {
      return this.channel.joinedOnce;
    }
    get joinPush() {
      return this.channel.joinPush;
    }
    get rejoinTimer() {
      return this.channel.rejoinTimer;
    }
    on(e, t) {
      return this.channel.on(e, t);
    }
    off(e, t) {
      this.channel.off(e, t);
    }
    subscribe(e) {
      return this.channel.join(e);
    }
    unsubscribe(e) {
      return this.channel.leave(e);
    }
    teardown() {
      this.channel.teardown();
    }
    onClose(e) {
      this.channel.onClose(e);
    }
    onError(e) {
      return this.channel.onError(e);
    }
    push(e, t, n) {
      var r;
      try {
        r = this.channel.push(e, t, n);
      } catch (_unused8) {
        throw Error(`tried to push '${e}' to '${this.channel.topic}' before joining. Use channel.subscribe() before pushing events`);
      }
      if (this.channel.pushBuffer.length > 100) {
        var _e10 = this.channel.pushBuffer.shift();
        _e10.cancelTimeout(), this.socket.log(`channel`, `discarded push due to buffer overflow: ${_e10.event}`, _e10.payload());
      }
      return r;
    }
    updateJoinPayload(e) {
      var t = this.channel.joinPush.payload();
      this.channel.joinPush.payload = () => Object.assign(Object.assign({}, t), e);
    }
    canPush() {
      return this.socket.isConnected() && this.state === v.joined;
    }
    isJoined() {
      return this.state === v.joined;
    }
    isJoining() {
      return this.state === v.joining;
    }
    isClosed() {
      return this.state === v.closed;
    }
    isLeaving() {
      return this.state === v.leaving;
    }
    updateFilterBindings(e) {
      this.channel.filterBindings = e;
    }
    updatePayloadTransform(e) {
      this.channel.onMessage = e;
    }
    getChannel() {
      return this.channel;
    }
  };
  function Xe(e) {
    return {
      config: Object.assign({
        broadcast: {
          ack: !1,
          self: !1
        },
        presence: {
          key: ``,
          enabled: !1
        },
        private: !1
      }, e.config)
    };
  }
  var Ze;
  (function (e) {
    e.ALL = `*`, e.INSERT = `INSERT`, e.UPDATE = `UPDATE`, e.DELETE = `DELETE`;
  })(Ze || (Ze = {}));
  var T;
  (function (e) {
    e.BROADCAST = `broadcast`, e.PRESENCE = `presence`, e.POSTGRES_CHANGES = `postgres_changes`, e.SYSTEM = `system`;
  })(T || (T = {}));
  var E;
  (function (e) {
    e.SUBSCRIBED = `SUBSCRIBED`, e.TIMED_OUT = `TIMED_OUT`, e.CLOSED = `CLOSED`, e.CHANNEL_ERROR = `CHANNEL_ERROR`;
  })(E || (E = {}));
  var Qe = v;
  var $e = class e {
      get state() {
        return this.channelAdapter.state;
      }
      set state(e) {
        this.channelAdapter.state = e;
      }
      get joinedOnce() {
        return this.channelAdapter.joinedOnce;
      }
      get timeout() {
        return this.socket.timeout;
      }
      get joinPush() {
        return this.channelAdapter.joinPush;
      }
      get rejoinTimer() {
        return this.channelAdapter.rejoinTimer;
      }
      constructor(e, t = {
        config: {}
      }, n) {
        var _this$params$config;
        if (this.topic = e, this.params = t, this.socket = n, this.bindings = {}, this.subTopic = e.replace(/^realtime:/i, ``), this.params.config = Object.assign({
          broadcast: {
            ack: !1,
            self: !1
          },
          presence: {
            key: ``,
            enabled: !1
          },
          private: !1
        }, t.config), this.channelAdapter = new Ye(this.socket.socketAdapter, e, this.params), this.presence = new qe(this), this._onClose(() => {
          this.socket._remove(this);
        }), this._updateFilterTransform(), this.broadcastEndpointURL = Ce(this.socket.socketAdapter.endPointURL()), this.private = this.params.config.private || !1, !this.private && (_this$params$config = this.params.config) !== null && _this$params$config !== void 0 && (_this$params$config = _this$params$config.broadcast) !== null && _this$params$config !== void 0 && _this$params$config.replay) throw Error(`tried to use replay on public channel '${this.topic}'. It must be a private channel.`);
      }
      subscribe(e, t = this.timeout) {
        var _this3 = this;
        if (this.socket.isConnected() || this.socket.connect(), this.channelAdapter.isClosed()) {
          var _this$bindings$postgr, _this$bindings$postgr2, _this$params$config$p;
          var _this$params$config2 = this.params.config,
            n = _this$params$config2.broadcast,
            r = _this$params$config2.presence,
            i = _this$params$config2.private,
            a = (_this$bindings$postgr = (_this$bindings$postgr2 = this.bindings.postgres_changes) === null || _this$bindings$postgr2 === void 0 ? void 0 : _this$bindings$postgr2.map(e => e.filter)) !== null && _this$bindings$postgr !== void 0 ? _this$bindings$postgr : [],
            o = !!this.bindings[T.PRESENCE] && this.bindings[T.PRESENCE].length > 0 || ((_this$params$config$p = this.params.config.presence) === null || _this$params$config$p === void 0 ? void 0 : _this$params$config$p.enabled) === !0,
            _s4 = {},
            _c4 = {
              broadcast: n,
              presence: Object.assign(Object.assign({}, r), {
                enabled: o
              }),
              postgres_changes: a,
              private: i
            };
          this.socket.accessTokenValue && (_s4.access_token = this.socket.accessTokenValue), this._onError(t => {
            e === null || e === void 0 || e(E.CHANNEL_ERROR, Je(t));
          }), this._onClose(() => e === null || e === void 0 ? void 0 : e(E.CLOSED)), this.updateJoinPayload(Object.assign({
            config: _c4
          }, _s4)), this._updateFilterMessage(), this.channelAdapter.subscribe(t).receive(`ok`, /*#__PURE__*/function () {
            var _ref4 = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee5({
              postgres_changes: t
            }) {
              return _regenerator().w(function (_context6) {
                while (1) switch (_context6.n) {
                  case 0:
                    if (!(_this3.socket._isManualToken() || _this3.socket.setAuth(), t === void 0)) {
                      _context6.n = 1;
                      break;
                    }
                    e === null || e === void 0 || e(E.SUBSCRIBED);
                    return _context6.a(2);
                  case 1:
                    _this3._updatePostgresBindings(t, e);
                  case 2:
                    return _context6.a(2);
                }
              }, _callee5);
            }));
            return function (_x) {
              return _ref4.apply(this, arguments);
            };
          }()).receive(`error`, t => {
            this.state = v.errored;
            var n = Object.values(t).join(`, `) || `error`;
            e === null || e === void 0 || e(E.CHANNEL_ERROR, Error(n, {
              cause: t
            }));
          }).receive(`timeout`, () => {
            e === null || e === void 0 || e(E.TIMED_OUT);
          });
        }
        return this;
      }
      _updatePostgresBindings(t, n) {
        var _r$length;
        var r = this.bindings.postgres_changes,
          i = (_r$length = r === null || r === void 0 ? void 0 : r.length) !== null && _r$length !== void 0 ? _r$length : 0,
          a = [];
        for (var o = 0; o < i; o++) {
          var _i8 = r[o],
            _i$filter = _i8.filter,
            _s5 = _i$filter.event,
            _c5 = _i$filter.schema,
            _l2 = _i$filter.table,
            _u2 = _i$filter.filter,
            _d2 = t && t[o];
          if (_d2 && _d2.event === _s5 && e.isFilterValueEqual(_d2.schema, _c5) && e.isFilterValueEqual(_d2.table, _l2) && e.isFilterValueEqual(_d2.filter, _u2)) a.push(Object.assign(Object.assign({}, _i8), {
            id: _d2.id
          }));else {
            this.unsubscribe(), this.state = v.errored, n === null || n === void 0 ? void 0 : n(E.CHANNEL_ERROR, Error(`mismatch between server and client bindings for postgres changes`));
            return;
          }
        }
        this.bindings.postgres_changes = a, this.state != v.errored && n && n(E.SUBSCRIBED);
      }
      presenceState() {
        return this.presence.state;
      }
      track(_x2) {
        var _this4 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee6(e, t = {}) {
          return _regenerator().w(function (_context7) {
            while (1) switch (_context7.n) {
              case 0:
                _context7.n = 1;
                return _this4.send({
                  type: `presence`,
                  event: `track`,
                  payload: e
                }, t.timeout || _this4.timeout);
              case 1:
                return _context7.a(2, _context7.v);
            }
          }, _callee6);
        })).apply(this, arguments);
      }
      untrack() {
        var _this5 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee7(e = {}) {
          return _regenerator().w(function (_context8) {
            while (1) switch (_context8.n) {
              case 0:
                _context8.n = 1;
                return _this5.send({
                  type: `presence`,
                  event: `untrack`
                }, e);
              case 1:
                return _context8.a(2, _context8.v);
            }
          }, _callee7);
        })).apply(this, arguments);
      }
      on(e, t, n) {
        var r = this.channelAdapter.isJoined() || this.channelAdapter.isJoining(),
          i = e === T.PRESENCE || e === T.POSTGRES_CHANGES;
        if (r && i) throw this.socket.log(`channel`, `cannot add \`${e}\` callbacks for ${this.topic} after \`subscribe()\`.`), Error(`cannot add \`${e}\` callbacks for ${this.topic} after \`subscribe()\`.`);
        return this._on(e, t, n);
      }
      httpSend(_x3, _x4) {
        var _this6 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee8(e, t, n = {}) {
          var _n$timeout;
          var r, i, a, o, s, c, _e11, _t17;
          return _regenerator().w(function (_context9) {
            while (1) switch (_context9.p = _context9.n) {
              case 0:
                if (!(t == null)) {
                  _context9.n = 1;
                  break;
                }
                return _context9.a(2, Promise.reject(Error(`Payload is required for httpSend()`)));
              case 1:
                r = t instanceof ArrayBuffer || ArrayBuffer.isView(t), i = {
                  apikey: _this6.socket.apiKey ? _this6.socket.apiKey : ``,
                  "Content-Type": r ? `application/octet-stream` : `application/json`
                };
                _this6.socket.accessTokenValue && (i.Authorization = `Bearer ${_this6.socket.accessTokenValue}`);
                a = new URL(_this6.broadcastEndpointURL);
                a.pathname += `/${encodeURIComponent(_this6.subTopic)}/events/${encodeURIComponent(e)}`, _this6.private && a.searchParams.set(`private`, `true`);
                o = {
                  method: `POST`,
                  headers: i,
                  body: r ? t : JSON.stringify(t)
                };
                _context9.n = 2;
                return _this6._fetchWithTimeout(a.toString(), o, (_n$timeout = n.timeout) !== null && _n$timeout !== void 0 ? _n$timeout : _this6.timeout);
              case 2:
                s = _context9.v;
                if (!(s.status === 202)) {
                  _context9.n = 3;
                  break;
                }
                return _context9.a(2, {
                  success: !0
                });
              case 3:
                if (!(s.status === 404)) {
                  _context9.n = 4;
                  break;
                }
                return _context9.a(2, Promise.reject(Error(`httpSend() requires Realtime server v2.97.0 or newer; the endpoint returned 404. Update your Supabase CLI to a recent version, or upgrade the Realtime server in your self-hosted setup. See https://github.com/supabase/supabase-js/blob/master/packages/core/realtime-js/migrations/httpsend-server-version.md`)));
              case 4:
                c = s.statusText;
                _context9.p = 5;
                _context9.n = 6;
                return s.json();
              case 6:
                _e11 = _context9.v;
                c = _e11.error || _e11.message || c;
                _context9.n = 8;
                break;
              case 7:
                _context9.p = 7;
                _t17 = _context9.v;
              case 8:
                return _context9.a(2, Promise.reject(Error(c)));
            }
          }, _callee8, null, [[5, 7]]);
        })).apply(this, arguments);
      }
      send(_x5) {
        var _this7 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee9(e, t = {}) {
          var n, r, i, a, _t$timeout, _e12$body, _e12, _t18;
          return _regenerator().w(function (_context0) {
            while (1) switch (_context0.p = _context0.n) {
              case 0:
                if (!(!_this7.channelAdapter.canPush() && e.type === `broadcast`)) {
                  _context0.n = 5;
                  break;
                }
                console.warn(`Realtime send() is automatically falling back to REST API. This behavior will be deprecated in the future. Please use httpSend() explicitly for REST delivery.`);
                n = e.event, r = e.payload, i = {
                  apikey: _this7.socket.apiKey ? _this7.socket.apiKey : ``,
                  "Content-Type": `application/json`
                };
                _this7.socket.accessTokenValue && (i.Authorization = `Bearer ${_this7.socket.accessTokenValue}`);
                a = {
                  method: `POST`,
                  headers: i,
                  body: JSON.stringify({
                    messages: [{
                      topic: _this7.subTopic,
                      event: n,
                      payload: r,
                      private: _this7.private
                    }]
                  })
                };
                _context0.p = 1;
                _context0.n = 2;
                return _this7._fetchWithTimeout(_this7.broadcastEndpointURL, a, (_t$timeout = t.timeout) !== null && _t$timeout !== void 0 ? _t$timeout : _this7.timeout);
              case 2:
                _e12 = _context0.v;
                _context0.n = 3;
                return (_e12$body = _e12.body) === null || _e12$body === void 0 ? void 0 : _e12$body.cancel();
              case 3:
                return _context0.a(2, _e12.ok ? `ok` : `error`);
              case 4:
                _context0.p = 4;
                _t18 = _context0.v;
                return _context0.a(2, _t18 instanceof Error && _t18.name === `AbortError` ? `timed out` : `error`);
              case 5:
                return _context0.a(2, new Promise(n => {
                  var _this7$params;
                  var r = _this7.channelAdapter.push(e.type, e, t.timeout || _this7.timeout);
                  e.type === `broadcast` && !((_this7$params = _this7.params) !== null && _this7$params !== void 0 && (_this7$params = _this7$params.config) !== null && _this7$params !== void 0 && (_this7$params = _this7$params.broadcast) !== null && _this7$params !== void 0 && _this7$params.ack) && n(`ok`), r.receive(`ok`, () => n(`ok`)), r.receive(`error`, () => n(`error`)), r.receive(`timeout`, () => n(`timed out`));
                }));
              case 6:
                return _context0.a(2);
            }
          }, _callee9, null, [[1, 4]]);
        })).apply(this, arguments);
      }
      updateJoinPayload(e) {
        this.channelAdapter.updateJoinPayload(e);
      }
      unsubscribe() {
        var _this8 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee0(e = _this8.timeout) {
          return _regenerator().w(function (_context1) {
            while (1) switch (_context1.n) {
              case 0:
                return _context1.a(2, new Promise(t => {
                  _this8.channelAdapter.unsubscribe(e).receive(`ok`, () => t(`ok`)).receive(`timeout`, () => t(`timed out`)).receive(`error`, () => t(`error`));
                }));
            }
          }, _callee0);
        })).apply(this, arguments);
      }
      teardown() {
        this.channelAdapter.teardown();
      }
      _fetchWithTimeout(e, t, n) {
        var _this9 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee1() {
          var r, i, a;
          return _regenerator().w(function (_context10) {
            while (1) switch (_context10.n) {
              case 0:
                r = new AbortController();
                i = setTimeout(() => r.abort(), n);
                _context10.n = 1;
                return _this9.socket.fetch(e, Object.assign(Object.assign({}, t), {
                  signal: r.signal
                }));
              case 1:
                a = _context10.v;
                return _context10.a(2, (clearTimeout(i), a));
            }
          }, _callee1);
        }))();
      }
      _on(e, t, n) {
        var r = e.toLocaleLowerCase(),
          i = {
            type: r,
            filter: t,
            callback: n,
            ref: this.channelAdapter.on(e, n)
          };
        return this.bindings[r] ? this.bindings[r].push(i) : this.bindings[r] = [i], this._updateFilterMessage(), this;
      }
      _onClose(e) {
        this.channelAdapter.onClose(e);
      }
      _onError(e) {
        this.channelAdapter.onError(e);
      }
      _updateFilterMessage() {
        this.channelAdapter.updateFilterBindings((e, t, n) => {
          var _this$bindings$r;
          var r = e.event.toLocaleLowerCase();
          if (this._notThisChannelEvent(r, n)) return !1;
          var i = (_this$bindings$r = this.bindings[r]) === null || _this$bindings$r === void 0 ? void 0 : _this$bindings$r.find(t => t.ref === e.ref);
          if (!i) return !0;
          if ([`broadcast`, `presence`, `postgres_changes`].includes(r)) {
            if (`id` in i) {
              var _i$filter2, _t$ids, _t$data;
              var _e13 = i.id,
                _n7 = (_i$filter2 = i.filter) === null || _i$filter2 === void 0 ? void 0 : _i$filter2.event;
              return _e13 && ((_t$ids = t.ids) === null || _t$ids === void 0 ? void 0 : _t$ids.includes(_e13)) && (_n7 === `*` || (_n7 === null || _n7 === void 0 ? void 0 : _n7.toLocaleLowerCase()) === ((_t$data = t.data) === null || _t$data === void 0 ? void 0 : _t$data.type.toLocaleLowerCase()));
            } else {
              var _i$filter3, _t$event;
              var _e14 = i === null || i === void 0 || (_i$filter3 = i.filter) === null || _i$filter3 === void 0 || (_i$filter3 = _i$filter3.event) === null || _i$filter3 === void 0 ? void 0 : _i$filter3.toLocaleLowerCase();
              return _e14 === `*` || _e14 === (t === null || t === void 0 || (_t$event = t.event) === null || _t$event === void 0 ? void 0 : _t$event.toLocaleLowerCase());
            }
          } else return i.type.toLocaleLowerCase() === r;
        });
      }
      _notThisChannelEvent(e, t) {
        var n = de.close,
          r = de.error,
          i = de.leave,
          a = de.join;
        return t && [n, r, i, a].includes(e) && t !== this.joinPush.ref;
      }
      _updateFilterTransform() {
        this.channelAdapter.updatePayloadTransform((e, t, n) => {
          if (typeof t == `object` && `ids` in t) {
            var _e15 = t.data,
              _n8 = _e15.schema,
              r = _e15.table,
              i = _e15.commit_timestamp,
              a = _e15.type,
              o = _e15.errors,
              s = {
                schema: _n8,
                table: r,
                commit_timestamp: i,
                eventType: a,
                new: {},
                old: {},
                errors: o
              };
            return Object.assign(Object.assign({}, s), this._getPayloadRecords(_e15));
          }
          return t;
        });
      }
      copyBindings(e) {
        if (this.joinedOnce) throw Error(`cannot copy bindings into joined channel`);
        for (var t in e.bindings) {
          var _iterator2 = _createForOfIteratorHelper(e.bindings[t]),
            _step2;
          try {
            for (_iterator2.s(); !(_step2 = _iterator2.n()).done;) {
              var n = _step2.value;
              this._on(n.type, n.filter, n.callback);
            }
          } catch (err) {
            _iterator2.e(err);
          } finally {
            _iterator2.f();
          }
        }
      }
      static isFilterValueEqual(e, t) {
        return (e !== null && e !== void 0 ? e : void 0) === (t !== null && t !== void 0 ? t : void 0);
      }
      _getPayloadRecords(e) {
        var t = {
          new: {},
          old: {}
        };
        return (e.type === `INSERT` || e.type === `UPDATE`) && (t.new = me(e.columns, e.record)), (e.type === `UPDATE` || e.type === `DELETE`) && (t.old = me(e.columns, e.old_record)), t;
      }
    },
    et = class {
      constructor(e, t) {
        this.socket = new Be(e, t);
      }
      get timeout() {
        return this.socket.timeout;
      }
      get endPoint() {
        return this.socket.endPoint;
      }
      get transport() {
        return this.socket.transport;
      }
      get heartbeatIntervalMs() {
        return this.socket.heartbeatIntervalMs;
      }
      get heartbeatCallback() {
        return this.socket.heartbeatCallback;
      }
      set heartbeatCallback(e) {
        this.socket.heartbeatCallback = e;
      }
      get heartbeatTimer() {
        return this.socket.heartbeatTimer;
      }
      get pendingHeartbeatRef() {
        return this.socket.pendingHeartbeatRef;
      }
      get reconnectTimer() {
        return this.socket.reconnectTimer;
      }
      get vsn() {
        return this.socket.vsn;
      }
      get encode() {
        return this.socket.encode;
      }
      get decode() {
        return this.socket.decode;
      }
      get reconnectAfterMs() {
        return this.socket.reconnectAfterMs;
      }
      get sendBuffer() {
        return this.socket.sendBuffer;
      }
      get stateChangeCallbacks() {
        return this.socket.stateChangeCallbacks;
      }
      connect() {
        this.socket.connect();
      }
      disconnect(e, t, n, r = 1e4) {
        return new Promise(i => {
          setTimeout(() => i(`timeout`), r), this.socket.disconnect(() => {
            e(), i(`ok`);
          }, t, n);
        });
      }
      push(e) {
        this.socket.push(e);
      }
      log(e, t, n) {
        this.socket.log(e, t, n);
      }
      makeRef() {
        return this.socket.makeRef();
      }
      onOpen(e) {
        this.socket.onOpen(e);
      }
      onClose(e) {
        this.socket.onClose(e);
      }
      onError(e) {
        this.socket.onError(e);
      }
      onMessage(e) {
        this.socket.onMessage(e);
      }
      isConnected() {
        return this.socket.isConnected();
      }
      isConnecting() {
        return this.socket.connectionState() == fe.connecting;
      }
      isDisconnecting() {
        return this.socket.connectionState() == fe.closing;
      }
      connectionState() {
        return this.socket.connectionState();
      }
      endPointURL() {
        return this.socket.endPointURL();
      }
      sendHeartbeat() {
        this.socket.sendHeartbeat();
      }
      getSocket() {
        return this.socket;
      }
    };
  var tt = {
      HEARTBEAT_INTERVAL: 25e3,
      RECONNECT_DELAY: 10,
      HEARTBEAT_TIMEOUT_FALLBACK: 100
    },
    nt = [1e3, 2e3, 5e3, 1e4];
  function rt() {
    var e = new Map();
    return {
      get length() {
        return e.size;
      },
      clear() {
        e.clear();
      },
      getItem(t) {
        return e.has(t) ? e.get(t) : null;
      },
      key(t) {
        var _Array$from$t;
        return (_Array$from$t = Array.from(e.keys())[t]) !== null && _Array$from$t !== void 0 ? _Array$from$t : null;
      },
      removeItem(t) {
        e.delete(t);
      },
      setItem(t, n) {
        e.set(t, String(n));
      }
    };
  }
  function it() {
    try {
      if (typeof globalThis < `u` && globalThis.sessionStorage) return globalThis.sessionStorage;
    } catch (_unused0) {}
    return rt();
  }
  var at = class {
      get endPoint() {
        return this.socketAdapter.endPoint;
      }
      get timeout() {
        return this.socketAdapter.timeout;
      }
      get transport() {
        return this.socketAdapter.transport;
      }
      get heartbeatCallback() {
        return this.socketAdapter.heartbeatCallback;
      }
      get heartbeatIntervalMs() {
        return this.socketAdapter.heartbeatIntervalMs;
      }
      get heartbeatTimer() {
        return this.worker ? this._workerHeartbeatTimer : this.socketAdapter.heartbeatTimer;
      }
      get pendingHeartbeatRef() {
        return this.worker ? this._pendingWorkerHeartbeatRef : this.socketAdapter.pendingHeartbeatRef;
      }
      get reconnectTimer() {
        return this.socketAdapter.reconnectTimer;
      }
      get vsn() {
        return this.socketAdapter.vsn;
      }
      get encode() {
        return this.socketAdapter.encode;
      }
      get decode() {
        return this.socketAdapter.decode;
      }
      get reconnectAfterMs() {
        return this.socketAdapter.reconnectAfterMs;
      }
      get sendBuffer() {
        return this.socketAdapter.sendBuffer;
      }
      get stateChangeCallbacks() {
        return this.socketAdapter.stateChangeCallbacks;
      }
      constructor(e, t) {
        var _t$params;
        if (this.channels = [], this.accessTokenValue = null, this.accessToken = null, this.apiKey = null, this.httpEndpoint = ``, this.headers = {}, this.params = {}, this.ref = 0, this.serializer = new pe(), this._manuallySetToken = !1, this._authPromise = null, this._workerHeartbeatTimer = void 0, this._pendingWorkerHeartbeatRef = null, this._pendingDisconnectTimer = null, this._disconnectOnEmptyChannelsAfterMs = 0, this._resolveFetch = e => e ? (...t) => e(...t) : (...e) => fetch(...e), !(t !== null && t !== void 0 && (_t$params = t.params) !== null && _t$params !== void 0 && _t$params.apikey)) throw Error(`API key is required to connect to Realtime`);
        this.apiKey = t.params.apikey, this.socketAdapter = new et(e, this._initializeOptions(t)), this.httpEndpoint = Ce(e), this.fetch = this._resolveFetch(t === null || t === void 0 ? void 0 : t.fetch);
      }
      connect() {
        if (!(this.isConnecting() || this.isDisconnecting() || this.isConnected())) {
          this.accessToken && !this._authPromise && this._setAuthSafely(`connect`), this._setupConnectionHandlers();
          try {
            this.socketAdapter.connect();
          } catch (e) {
            var t = e.message;
            throw t.includes(`Node.js`) ? Error(`${t}\n\nTo use Realtime in Node.js, you need to provide a WebSocket implementation:

Option 1: Use Node.js 22+ which has native WebSocket support
Option 2: Install and provide the "ws" package:

  npm install ws

  import ws from "ws"
  const client = new RealtimeClient(url, {
    ...options,
    transport: ws
  })`) : Error(`WebSocket not available: ${t}`);
          }
          this._handleNodeJsRaceCondition();
        }
      }
      endpointURL() {
        return this.socketAdapter.endPointURL();
      }
      disconnect(e, t) {
        var _this0 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee10() {
          var _t19;
          return _regenerator().w(function (_context11) {
            while (1) switch (_context11.n) {
              case 0:
                _this0._cancelPendingDisconnect();
                if (!_this0.isDisconnecting()) {
                  _context11.n = 1;
                  break;
                }
                _t19 = `ok`;
                _context11.n = 3;
                break;
              case 1:
                _context11.n = 2;
                return _this0.socketAdapter.disconnect(() => {
                  clearInterval(_this0._workerHeartbeatTimer), _this0._terminateWorker();
                }, e, t);
              case 2:
                _t19 = _context11.v;
              case 3:
                return _context11.a(2, _t19);
            }
          }, _callee10);
        }))();
      }
      getChannels() {
        return this.channels;
      }
      removeChannel(e) {
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee11() {
          var t;
          return _regenerator().w(function (_context12) {
            while (1) switch (_context12.n) {
              case 0:
                _context12.n = 1;
                return e.unsubscribe();
              case 1:
                t = _context12.v;
                return _context12.a(2, (t === `ok` && e.teardown(), t));
            }
          }, _callee11);
        }))();
      }
      removeAllChannels() {
        var _this1 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee13() {
          var e, t;
          return _regenerator().w(function (_context14) {
            while (1) switch (_context14.n) {
              case 0:
                e = _this1.channels.map(/*#__PURE__*/function () {
                  var _ref5 = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee12(e) {
                    var t;
                    return _regenerator().w(function (_context13) {
                      while (1) switch (_context13.n) {
                        case 0:
                          _context13.n = 1;
                          return e.unsubscribe();
                        case 1:
                          t = _context13.v;
                          return _context13.a(2, (e.teardown(), t));
                      }
                    }, _callee12);
                  }));
                  return function (_x6) {
                    return _ref5.apply(this, arguments);
                  };
                }());
                _context14.n = 1;
                return Promise.all(e);
              case 1:
                t = _context14.v;
                _context14.n = 2;
                return _this1.disconnect();
              case 2:
                return _context14.a(2, t);
            }
          }, _callee13);
        }))();
      }
      log(e, t, n) {
        this.socketAdapter.log(e, t, n);
      }
      connectionState() {
        return this.socketAdapter.connectionState() || fe.closed;
      }
      isConnected() {
        return this.socketAdapter.isConnected();
      }
      isConnecting() {
        return this.socketAdapter.isConnecting();
      }
      isDisconnecting() {
        return this.socketAdapter.isDisconnecting();
      }
      channel(e, t = {
        config: {}
      }) {
        var n = `realtime:${e}`,
          r = this.getChannels().find(e => e.topic === n);
        if (r) return r;
        {
          var _n9 = new $e(`realtime:${e}`, t, this);
          return this._cancelPendingDisconnect(), this.channels.push(_n9), _n9;
        }
      }
      push(e) {
        this.socketAdapter.push(e);
      }
      setAuth() {
        var _this10 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee14(e = null) {
          return _regenerator().w(function (_context15) {
            while (1) switch (_context15.p = _context15.n) {
              case 0:
                _this10._authPromise = _this10._performAuth(e);
                _context15.p = 1;
                _context15.n = 2;
                return _this10._authPromise;
              case 2:
                _context15.p = 2;
                _this10._authPromise = null;
                return _context15.f(2);
              case 3:
                return _context15.a(2);
            }
          }, _callee14, null, [[1,, 2, 3]]);
        })).apply(this, arguments);
      }
      _isManualToken() {
        return this._manuallySetToken;
      }
      sendHeartbeat() {
        var _this11 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee15() {
          return _regenerator().w(function (_context16) {
            while (1) switch (_context16.n) {
              case 0:
                _this11.socketAdapter.sendHeartbeat();
              case 1:
                return _context16.a(2);
            }
          }, _callee15);
        }))();
      }
      onHeartbeat(e) {
        this.socketAdapter.heartbeatCallback = this._wrapHeartbeatCallback(e);
      }
      _makeRef() {
        return this.socketAdapter.makeRef();
      }
      _remove(e) {
        this.channels = this.channels.filter(t => t.topic !== e.topic), this.channels.length === 0 && (this.log(`transport`, `no channels remaining, scheduling disconnect`), this._schedulePendingDisconnect());
      }
      _schedulePendingDisconnect() {
        if (this._cancelPendingDisconnect(), this._disconnectOnEmptyChannelsAfterMs === 0) {
          this.log(`transport`, `disconnecting immediately - no channels`), this.disconnect();
          return;
        }
        this._pendingDisconnectTimer = setTimeout(() => {
          this._pendingDisconnectTimer = null, this.channels.length === 0 && (this.log(`transport`, `deferred disconnect fired - no channels, disconnecting`), this.disconnect());
        }, this._disconnectOnEmptyChannelsAfterMs), this.log(`transport`, `deferred disconnect scheduled in ${this._disconnectOnEmptyChannelsAfterMs}ms`);
      }
      _cancelPendingDisconnect() {
        this._pendingDisconnectTimer !== null && (this.log(`transport`, `pending disconnect cancelled - channel activity detected`), clearTimeout(this._pendingDisconnectTimer), this._pendingDisconnectTimer = null);
      }
      _performAuth() {
        var _this12 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee16(e = null) {
          var t, n, _t20;
          return _regenerator().w(function (_context17) {
            while (1) switch (_context17.p = _context17.n) {
              case 0:
                n = !1;
                if (!e) {
                  _context17.n = 1;
                  break;
                }
                t = e, n = !0;
                _context17.n = 7;
                break;
              case 1:
                if (!_this12.accessToken) {
                  _context17.n = 6;
                  break;
                }
                _context17.p = 2;
                _context17.n = 3;
                return _this12.accessToken();
              case 3:
                t = _context17.v;
                _context17.n = 5;
                break;
              case 4:
                _context17.p = 4;
                _t20 = _context17.v;
                _this12.log(`error`, `Error fetching access token from callback`, _t20), t = _this12.accessTokenValue;
              case 5:
                _context17.n = 7;
                break;
              case 6:
                t = _this12.accessTokenValue;
              case 7:
                n ? _this12._manuallySetToken = !0 : _this12.accessToken && (_this12._manuallySetToken = !1), _this12.accessTokenValue != t && (_this12.accessTokenValue = t, _this12.channels.forEach(e => {
                  var n = {
                    access_token: t,
                    version: `realtime-js/2.108.2`
                  };
                  t && e.updateJoinPayload(n), e.joinedOnce && e.channelAdapter.isJoined() && e.channelAdapter.push(de.access_token, {
                    access_token: t
                  });
                }));
              case 8:
                return _context17.a(2);
            }
          }, _callee16, null, [[2, 4]]);
        })).apply(this, arguments);
      }
      _waitForAuthIfNeeded() {
        var _this13 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee17() {
          var _t21;
          return _regenerator().w(function (_context18) {
            while (1) switch (_context18.n) {
              case 0:
                _t21 = _this13._authPromise;
                if (!_t21) {
                  _context18.n = 1;
                  break;
                }
                _context18.n = 1;
                return _this13._authPromise;
              case 1:
                return _context18.a(2);
            }
          }, _callee17);
        }))();
      }
      _setAuthSafely(e = `general`) {
        this._isManualToken() || this.setAuth().catch(t => {
          this.log(`error`, `Error setting auth in ${e}`, t);
        });
      }
      _setupConnectionHandlers() {
        this.socketAdapter.onOpen(() => {
          (this._authPromise || (this.accessToken && !this.accessTokenValue ? this.setAuth() : Promise.resolve())).catch(e => {
            this.log(`error`, `error waiting for auth on connect`, e);
          }), this.worker && !this.workerRef && this._startWorkerHeartbeat();
        }), this.socketAdapter.onClose(() => {
          this.worker && this.workerRef && this._terminateWorker();
        }), this.socketAdapter.onMessage(e => {
          e.ref && e.ref === this._pendingWorkerHeartbeatRef && (this._pendingWorkerHeartbeatRef = null);
        });
      }
      _handleNodeJsRaceCondition() {
        this.socketAdapter.isConnected() && this.socketAdapter.getSocket().onConnOpen();
      }
      _wrapHeartbeatCallback(e) {
        return (t, n) => {
          t == `sent` && this._setAuthSafely(), e && e(t, n);
        };
      }
      _startWorkerHeartbeat() {
        this.workerUrl ? this.log(`worker`, `starting worker for from ${this.workerUrl}`) : this.log(`worker`, `starting default worker`);
        var e = this._workerObjectUrl(this.workerUrl);
        this.workerRef = new Worker(e), this.workerRef.onerror = e => {
          this.log(`worker`, `worker error`, e.message), this._terminateWorker(), this.disconnect();
        }, this.workerRef.onmessage = e => {
          e.data.event === `keepAlive` && this.sendHeartbeat();
        }, this.workerRef.postMessage({
          event: `start`,
          interval: this.heartbeatIntervalMs
        });
      }
      _terminateWorker() {
        this.workerRef && (this.workerRef = (this.log(`worker`, `terminating worker`), this.workerRef.terminate(), void 0));
      }
      _workerObjectUrl(e) {
        var t;
        if (e) t = e;else {
          var _e16 = new Blob([`
  addEventListener("message", (e) => {
    if (e.data.event === "start") {
      setInterval(() => postMessage({ event: "keepAlive" }), e.data.interval);
    }
  });`], {
            type: `application/javascript`
          });
          t = URL.createObjectURL(_e16);
        }
        return t;
      }
      _initializeOptions(e) {
        var _e$worker, _e$accessToken, _e$timeout, _e$heartbeatIntervalM, _e$disconnectOnEmptyC, _e$heartbeatIntervalM2, _e$transport, _e$sessionStorage, _e$reconnectAfterMs, _e$vsn, _e$encode, _e$decode;
        this.worker = (_e$worker = e === null || e === void 0 ? void 0 : e.worker) !== null && _e$worker !== void 0 ? _e$worker : !1, this.accessToken = (_e$accessToken = e === null || e === void 0 ? void 0 : e.accessToken) !== null && _e$accessToken !== void 0 ? _e$accessToken : null;
        var t = {};
        t.timeout = (_e$timeout = e === null || e === void 0 ? void 0 : e.timeout) !== null && _e$timeout !== void 0 ? _e$timeout : 1e4, t.heartbeatIntervalMs = (_e$heartbeatIntervalM = e === null || e === void 0 ? void 0 : e.heartbeatIntervalMs) !== null && _e$heartbeatIntervalM !== void 0 ? _e$heartbeatIntervalM : tt.HEARTBEAT_INTERVAL, this._disconnectOnEmptyChannelsAfterMs = (_e$disconnectOnEmptyC = e === null || e === void 0 ? void 0 : e.disconnectOnEmptyChannelsAfterMs) !== null && _e$disconnectOnEmptyC !== void 0 ? _e$disconnectOnEmptyC : 2 * ((_e$heartbeatIntervalM2 = e === null || e === void 0 ? void 0 : e.heartbeatIntervalMs) !== null && _e$heartbeatIntervalM2 !== void 0 ? _e$heartbeatIntervalM2 : tt.HEARTBEAT_INTERVAL), t.transport = (_e$transport = e === null || e === void 0 ? void 0 : e.transport) !== null && _e$transport !== void 0 ? _e$transport : ue.getWebSocketConstructor(), t.params = e === null || e === void 0 ? void 0 : e.params, t.logger = e === null || e === void 0 ? void 0 : e.logger, t.heartbeatCallback = this._wrapHeartbeatCallback(e === null || e === void 0 ? void 0 : e.heartbeatCallback), t.sessionStorage = (_e$sessionStorage = e === null || e === void 0 ? void 0 : e.sessionStorage) !== null && _e$sessionStorage !== void 0 ? _e$sessionStorage : it(), t.reconnectAfterMs = (_e$reconnectAfterMs = e === null || e === void 0 ? void 0 : e.reconnectAfterMs) !== null && _e$reconnectAfterMs !== void 0 ? _e$reconnectAfterMs : e => nt[e - 1] || 1e4;
        var n,
          r,
          i = (_e$vsn = e === null || e === void 0 ? void 0 : e.vsn) !== null && _e$vsn !== void 0 ? _e$vsn : `2.0.0`;
        switch (i) {
          case `1.0.0`:
            n = (e, t) => t(JSON.stringify(e)), r = (e, t) => t(JSON.parse(e));
            break;
          case `2.0.0`:
            n = this.serializer.encode.bind(this.serializer), r = this.serializer.decode.bind(this.serializer);
            break;
          default:
            throw Error(`Unsupported serializer version: ${t.vsn}`);
        }
        if (t.vsn = i, t.encode = (_e$encode = e === null || e === void 0 ? void 0 : e.encode) !== null && _e$encode !== void 0 ? _e$encode : n, t.decode = (_e$decode = e === null || e === void 0 ? void 0 : e.decode) !== null && _e$decode !== void 0 ? _e$decode : r, t.beforeReconnect = this._reconnectAuth.bind(this), (e !== null && e !== void 0 && e.logLevel || e !== null && e !== void 0 && e.log_level) && (this.logLevel = e.logLevel || e.log_level, t.params = Object.assign(Object.assign({}, t.params), {
          log_level: this.logLevel
        })), this.worker) {
          if (typeof window < `u` && !window.Worker) throw Error(`Web Worker is not supported`);
          this.workerUrl = e === null || e === void 0 ? void 0 : e.workerUrl, t.autoSendHeartbeat = !this.worker;
        }
        return t;
      }
      _reconnectAuth() {
        var _this14 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee18() {
          return _regenerator().w(function (_context19) {
            while (1) switch (_context19.n) {
              case 0:
                _context19.n = 1;
                return _this14._waitForAuthIfNeeded();
              case 1:
                _this14.isConnected() || _this14.connect();
              case 2:
                return _context19.a(2);
            }
          }, _callee18);
        }))();
      }
    },
    ot = class extends Error {
      constructor(e, t) {
        var _t$icebergType;
        super(e), this.name = `IcebergError`, this.status = t.status, this.icebergType = t.icebergType, this.icebergCode = t.icebergCode, this.details = t.details, this.isCommitStateUnknown = t.icebergType === `CommitStateUnknownException` || [500, 502, 504].includes(t.status) && ((_t$icebergType = t.icebergType) === null || _t$icebergType === void 0 ? void 0 : _t$icebergType.includes(`CommitState`)) === !0;
      }
      isNotFound() {
        return this.status === 404;
      }
      isConflict() {
        return this.status === 409;
      }
      isAuthenticationTimeout() {
        return this.status === 419;
      }
    };
  function st(e, t, n) {
    var r = new URL(t, e);
    if (n) for (var _i9 = 0, _Object$entries2 = Object.entries(n); _i9 < _Object$entries2.length; _i9++) {
      var _Object$entries2$_i = _slicedToArray(_Object$entries2[_i9], 2),
        _e17 = _Object$entries2$_i[0],
        _t22 = _Object$entries2$_i[1];
      _t22 !== void 0 && r.searchParams.set(_e17, _t22);
    }
    return r.toString();
  }
  function ct(_x7) {
    return _ct.apply(this, arguments);
  }
  function _ct() {
    _ct = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee308(e) {
      var _t260, _t261, _t262, _t263;
      return _regenerator().w(function (_context309) {
        while (1) switch (_context309.n) {
          case 0:
            if (!(!e || e.type === `none`)) {
              _context309.n = 1;
              break;
            }
            _t260 = {};
            _context309.n = 9;
            break;
          case 1:
            if (!(e.type === `bearer`)) {
              _context309.n = 2;
              break;
            }
            _t261 = {
              Authorization: `Bearer ${e.token}`
            };
            _context309.n = 8;
            break;
          case 2:
            if (!(e.type === `header`)) {
              _context309.n = 3;
              break;
            }
            _t262 = {
              [e.name]: e.value
            };
            _context309.n = 7;
            break;
          case 3:
            if (!(e.type === `custom`)) {
              _context309.n = 5;
              break;
            }
            _context309.n = 4;
            return e.getHeaders();
          case 4:
            _t263 = _context309.v;
            _context309.n = 6;
            break;
          case 5:
            _t263 = {};
          case 6:
            _t262 = _t263;
          case 7:
            _t261 = _t262;
          case 8:
            _t260 = _t261;
          case 9:
            return _context309.a(2, _t260);
        }
      }, _callee308);
    }));
    return _ct.apply(this, arguments);
  }
  function lt(e) {
    var _e$fetchImpl;
    var t = (_e$fetchImpl = e.fetchImpl) !== null && _e$fetchImpl !== void 0 ? _e$fetchImpl : globalThis.fetch;
    return {
      request(_x8) {
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee19({
          method: n,
          path: r,
          query: i,
          body: a,
          headers: o
        }) {
          var s, c, l, u, d, f, _t23$message, _e18, _t23;
          return _regenerator().w(function (_context20) {
            while (1) switch (_context20.n) {
              case 0:
                s = st(e.baseUrl, r, i);
                _context20.n = 1;
                return ct(e.auth);
              case 1:
                c = _context20.v;
                _context20.n = 2;
                return t(s, {
                  method: n,
                  headers: _objectSpread(_objectSpread(_objectSpread({}, a ? {
                    "Content-Type": `application/json`
                  } : {}), c), o),
                  body: a ? JSON.stringify(a) : void 0
                });
              case 2:
                l = _context20.v;
                _context20.n = 3;
                return l.text();
              case 3:
                u = _context20.v;
                d = (l.headers.get(`content-type`) || ``).includes(`application/json`);
                f = d && u ? JSON.parse(u) : u;
                if (l.ok) {
                  _context20.n = 4;
                  break;
                }
                _e18 = d ? f : void 0, _t23 = _e18 === null || _e18 === void 0 ? void 0 : _e18.error;
                throw new ot((_t23$message = _t23 === null || _t23 === void 0 ? void 0 : _t23.message) !== null && _t23$message !== void 0 ? _t23$message : `Request failed with status ${l.status}`, {
                  status: l.status,
                  icebergType: _t23 === null || _t23 === void 0 ? void 0 : _t23.type,
                  icebergCode: _t23 === null || _t23 === void 0 ? void 0 : _t23.code,
                  details: _e18
                });
              case 4:
                return _context20.a(2, {
                  status: l.status,
                  headers: l.headers,
                  data: f
                });
            }
          }, _callee19);
        })).apply(this, arguments);
      }
    };
  }
  function ut(e) {
    return e.join(``);
  }
  var dt = class {
    constructor(e, t = ``) {
      this.client = e, this.prefix = t;
    }
    listNamespaces(e) {
      var _this15 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee20() {
        var t;
        return _regenerator().w(function (_context21) {
          while (1) switch (_context21.n) {
            case 0:
              t = e ? {
                parent: ut(e.namespace)
              } : void 0;
              _context21.n = 1;
              return _this15.client.request({
                method: `GET`,
                path: `${_this15.prefix}/namespaces`,
                query: t
              });
            case 1:
              return _context21.a(2, _context21.v.data.namespaces.map(e => ({
                namespace: e
              })));
          }
        }, _callee20);
      }))();
    }
    createNamespace(e, t) {
      var _this16 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee21() {
        var n;
        return _regenerator().w(function (_context22) {
          while (1) switch (_context22.n) {
            case 0:
              n = {
                namespace: e.namespace,
                properties: t === null || t === void 0 ? void 0 : t.properties
              };
              _context22.n = 1;
              return _this16.client.request({
                method: `POST`,
                path: `${_this16.prefix}/namespaces`,
                body: n
              });
            case 1:
              return _context22.a(2, _context22.v.data);
          }
        }, _callee21);
      }))();
    }
    dropNamespace(e) {
      var _this17 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee22() {
        return _regenerator().w(function (_context23) {
          while (1) switch (_context23.n) {
            case 0:
              _context23.n = 1;
              return _this17.client.request({
                method: `DELETE`,
                path: `${_this17.prefix}/namespaces/${ut(e.namespace)}`
              });
            case 1:
              return _context23.a(2);
          }
        }, _callee22);
      }))();
    }
    loadNamespaceMetadata(e) {
      var _this18 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee23() {
        var _t24;
        return _regenerator().w(function (_context24) {
          while (1) switch (_context24.n) {
            case 0:
              _context24.n = 1;
              return _this18.client.request({
                method: `GET`,
                path: `${_this18.prefix}/namespaces/${ut(e.namespace)}`
              });
            case 1:
              _t24 = _context24.v.data.properties;
              return _context24.a(2, {
                properties: _t24
              });
          }
        }, _callee23);
      }))();
    }
    namespaceExists(e) {
      var _this19 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee24() {
        var _t25;
        return _regenerator().w(function (_context25) {
          while (1) switch (_context25.p = _context25.n) {
            case 0:
              _context25.p = 0;
              _context25.n = 1;
              return _this19.client.request({
                method: `HEAD`,
                path: `${_this19.prefix}/namespaces/${ut(e.namespace)}`
              });
            case 1:
              return _context25.a(2, !0);
            case 2:
              _context25.p = 2;
              _t25 = _context25.v;
              if (!(_t25 instanceof ot && _t25.status === 404)) {
                _context25.n = 3;
                break;
              }
              return _context25.a(2, !1);
            case 3:
              throw _t25;
            case 4:
              return _context25.a(2);
          }
        }, _callee24, null, [[0, 2]]);
      }))();
    }
    createNamespaceIfNotExists(e, t) {
      var _this20 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee25() {
        var _t26;
        return _regenerator().w(function (_context26) {
          while (1) switch (_context26.p = _context26.n) {
            case 0:
              _context26.p = 0;
              _context26.n = 1;
              return _this20.createNamespace(e, t);
            case 1:
              return _context26.a(2, _context26.v);
            case 2:
              _context26.p = 2;
              _t26 = _context26.v;
              if (!(_t26 instanceof ot && _t26.status === 409)) {
                _context26.n = 3;
                break;
              }
              return _context26.a(2);
            case 3:
              throw _t26;
            case 4:
              return _context26.a(2);
          }
        }, _callee25, null, [[0, 2]]);
      }))();
    }
  };
  function D(e) {
    return e.join(``);
  }
  var ft = class {
      constructor(e, t = ``, n) {
        this.client = e, this.prefix = t, this.accessDelegation = n;
      }
      listTables(e) {
        var _this21 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee26() {
          return _regenerator().w(function (_context27) {
            while (1) switch (_context27.n) {
              case 0:
                _context27.n = 1;
                return _this21.client.request({
                  method: `GET`,
                  path: `${_this21.prefix}/namespaces/${D(e.namespace)}/tables`
                });
              case 1:
                return _context27.a(2, _context27.v.data.identifiers);
            }
          }, _callee26);
        }))();
      }
      createTable(e, t) {
        var _this22 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee27() {
          var n;
          return _regenerator().w(function (_context28) {
            while (1) switch (_context28.n) {
              case 0:
                n = {};
                _this22.accessDelegation && (n[`X-Iceberg-Access-Delegation`] = _this22.accessDelegation);
                _context28.n = 1;
                return _this22.client.request({
                  method: `POST`,
                  path: `${_this22.prefix}/namespaces/${D(e.namespace)}/tables`,
                  body: t,
                  headers: n
                });
              case 1:
                return _context28.a(2, _context28.v.data.metadata);
            }
          }, _callee27);
        }))();
      }
      updateTable(e, t) {
        var _this23 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee28() {
          var n;
          return _regenerator().w(function (_context29) {
            while (1) switch (_context29.n) {
              case 0:
                _context29.n = 1;
                return _this23.client.request({
                  method: `POST`,
                  path: `${_this23.prefix}/namespaces/${D(e.namespace)}/tables/${e.name}`,
                  body: t
                });
              case 1:
                n = _context29.v;
                return _context29.a(2, {
                  "metadata-location": n.data[`metadata-location`],
                  metadata: n.data.metadata
                });
            }
          }, _callee28);
        }))();
      }
      dropTable(e, t) {
        var _this24 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee29() {
          var _t$purge;
          return _regenerator().w(function (_context30) {
            while (1) switch (_context30.n) {
              case 0:
                _context30.n = 1;
                return _this24.client.request({
                  method: `DELETE`,
                  path: `${_this24.prefix}/namespaces/${D(e.namespace)}/tables/${e.name}`,
                  query: {
                    purgeRequested: String((_t$purge = t === null || t === void 0 ? void 0 : t.purge) !== null && _t$purge !== void 0 ? _t$purge : !1)
                  }
                });
              case 1:
                return _context30.a(2);
            }
          }, _callee29);
        }))();
      }
      loadTable(e) {
        var _this25 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee30() {
          var t;
          return _regenerator().w(function (_context31) {
            while (1) switch (_context31.n) {
              case 0:
                t = {};
                _this25.accessDelegation && (t[`X-Iceberg-Access-Delegation`] = _this25.accessDelegation);
                _context31.n = 1;
                return _this25.client.request({
                  method: `GET`,
                  path: `${_this25.prefix}/namespaces/${D(e.namespace)}/tables/${e.name}`,
                  headers: t
                });
              case 1:
                return _context31.a(2, _context31.v.data.metadata);
            }
          }, _callee30);
        }))();
      }
      tableExists(e) {
        var _this26 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee31() {
          var t, _t27;
          return _regenerator().w(function (_context32) {
            while (1) switch (_context32.p = _context32.n) {
              case 0:
                t = {};
                _this26.accessDelegation && (t[`X-Iceberg-Access-Delegation`] = _this26.accessDelegation);
                _context32.p = 1;
                _context32.n = 2;
                return _this26.client.request({
                  method: `HEAD`,
                  path: `${_this26.prefix}/namespaces/${D(e.namespace)}/tables/${e.name}`,
                  headers: t
                });
              case 2:
                return _context32.a(2, !0);
              case 3:
                _context32.p = 3;
                _t27 = _context32.v;
                if (!(_t27 instanceof ot && _t27.status === 404)) {
                  _context32.n = 4;
                  break;
                }
                return _context32.a(2, !1);
              case 4:
                throw _t27;
              case 5:
                return _context32.a(2);
            }
          }, _callee31, null, [[1, 3]]);
        }))();
      }
      createTableIfNotExists(e, t) {
        var _this27 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee32() {
          var _t28;
          return _regenerator().w(function (_context33) {
            while (1) switch (_context33.p = _context33.n) {
              case 0:
                _context33.p = 0;
                _context33.n = 1;
                return _this27.createTable(e, t);
              case 1:
                return _context33.a(2, _context33.v);
              case 2:
                _context33.p = 2;
                _t28 = _context33.v;
                if (!(_t28 instanceof ot && _t28.status === 409)) {
                  _context33.n = 4;
                  break;
                }
                _context33.n = 3;
                return _this27.loadTable({
                  namespace: e.namespace,
                  name: t.name
                });
              case 3:
                return _context33.a(2, _context33.v);
              case 4:
                throw _t28;
              case 5:
                return _context33.a(2);
            }
          }, _callee32, null, [[0, 2]]);
        }))();
      }
    },
    pt = class {
      constructor(e) {
        var _e$accessDelegation;
        var t = `v1`;
        e.catalogName && (t += `/${e.catalogName}`), this.client = lt({
          baseUrl: e.baseUrl.endsWith(`/`) ? e.baseUrl : `${e.baseUrl}/`,
          auth: e.auth,
          fetchImpl: e.fetch
        }), this.accessDelegation = (_e$accessDelegation = e.accessDelegation) === null || _e$accessDelegation === void 0 ? void 0 : _e$accessDelegation.join(`,`), this.namespaceOps = new dt(this.client, t), this.tableOps = new ft(this.client, t, this.accessDelegation);
      }
      listNamespaces(e) {
        var _this28 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee33() {
          return _regenerator().w(function (_context34) {
            while (1) switch (_context34.n) {
              case 0:
                return _context34.a(2, _this28.namespaceOps.listNamespaces(e));
            }
          }, _callee33);
        }))();
      }
      createNamespace(e, t) {
        var _this29 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee34() {
          return _regenerator().w(function (_context35) {
            while (1) switch (_context35.n) {
              case 0:
                return _context35.a(2, _this29.namespaceOps.createNamespace(e, t));
            }
          }, _callee34);
        }))();
      }
      dropNamespace(e) {
        var _this30 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee35() {
          return _regenerator().w(function (_context36) {
            while (1) switch (_context36.n) {
              case 0:
                _context36.n = 1;
                return _this30.namespaceOps.dropNamespace(e);
              case 1:
                return _context36.a(2);
            }
          }, _callee35);
        }))();
      }
      loadNamespaceMetadata(e) {
        var _this31 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee36() {
          return _regenerator().w(function (_context37) {
            while (1) switch (_context37.n) {
              case 0:
                return _context37.a(2, _this31.namespaceOps.loadNamespaceMetadata(e));
            }
          }, _callee36);
        }))();
      }
      listTables(e) {
        var _this32 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee37() {
          return _regenerator().w(function (_context38) {
            while (1) switch (_context38.n) {
              case 0:
                return _context38.a(2, _this32.tableOps.listTables(e));
            }
          }, _callee37);
        }))();
      }
      createTable(e, t) {
        var _this33 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee38() {
          return _regenerator().w(function (_context39) {
            while (1) switch (_context39.n) {
              case 0:
                return _context39.a(2, _this33.tableOps.createTable(e, t));
            }
          }, _callee38);
        }))();
      }
      updateTable(e, t) {
        var _this34 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee39() {
          return _regenerator().w(function (_context40) {
            while (1) switch (_context40.n) {
              case 0:
                return _context40.a(2, _this34.tableOps.updateTable(e, t));
            }
          }, _callee39);
        }))();
      }
      dropTable(e, t) {
        var _this35 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee40() {
          return _regenerator().w(function (_context41) {
            while (1) switch (_context41.n) {
              case 0:
                _context41.n = 1;
                return _this35.tableOps.dropTable(e, t);
              case 1:
                return _context41.a(2);
            }
          }, _callee40);
        }))();
      }
      loadTable(e) {
        var _this36 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee41() {
          return _regenerator().w(function (_context42) {
            while (1) switch (_context42.n) {
              case 0:
                return _context42.a(2, _this36.tableOps.loadTable(e));
            }
          }, _callee41);
        }))();
      }
      namespaceExists(e) {
        var _this37 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee42() {
          return _regenerator().w(function (_context43) {
            while (1) switch (_context43.n) {
              case 0:
                return _context43.a(2, _this37.namespaceOps.namespaceExists(e));
            }
          }, _callee42);
        }))();
      }
      tableExists(e) {
        var _this38 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee43() {
          return _regenerator().w(function (_context44) {
            while (1) switch (_context44.n) {
              case 0:
                return _context44.a(2, _this38.tableOps.tableExists(e));
            }
          }, _callee43);
        }))();
      }
      createNamespaceIfNotExists(e, t) {
        var _this39 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee44() {
          return _regenerator().w(function (_context45) {
            while (1) switch (_context45.n) {
              case 0:
                return _context45.a(2, _this39.namespaceOps.createNamespaceIfNotExists(e, t));
            }
          }, _callee44);
        }))();
      }
      createTableIfNotExists(e, t) {
        var _this40 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee45() {
          return _regenerator().w(function (_context46) {
            while (1) switch (_context46.n) {
              case 0:
                return _context46.a(2, _this40.tableOps.createTableIfNotExists(e, t));
            }
          }, _callee45);
        }))();
      }
    };
  function mt(e) {
    "@babel/helpers - typeof";

    return mt = typeof Symbol == `function` && typeof Symbol.iterator == `symbol` ? function (e) {
      return typeof e;
    } : function (e) {
      return e && typeof Symbol == `function` && e.constructor === Symbol && e !== Symbol.prototype ? `symbol` : typeof e;
    }, mt(e);
  }
  function ht(e, t) {
    if (mt(e) != `object` || !e) return e;
    var n = e[Symbol.toPrimitive];
    if (n !== void 0) {
      var r = n.call(e, t || `default`);
      if (mt(r) != `object`) return r;
      throw TypeError(`@@toPrimitive must return a primitive value.`);
    }
    return (t === `string` ? String : Number)(e);
  }
  function gt(e) {
    var t = ht(e, `string`);
    return mt(t) == `symbol` ? t : t + ``;
  }
  function _t(e, t, n) {
    return (t = gt(t)) in e ? Object.defineProperty(e, t, {
      value: n,
      enumerable: !0,
      configurable: !0,
      writable: !0
    }) : e[t] = n, e;
  }
  function vt(e, t) {
    var n = Object.keys(e);
    if (Object.getOwnPropertySymbols) {
      var r = Object.getOwnPropertySymbols(e);
      t && (r = r.filter(function (t) {
        return Object.getOwnPropertyDescriptor(e, t).enumerable;
      })), n.push.apply(n, r);
    }
    return n;
  }
  function O(e) {
    for (var t = 1; t < arguments.length; t++) {
      var n = arguments[t] == null ? {} : arguments[t];
      t % 2 ? vt(Object(n), !0).forEach(function (t) {
        _t(e, t, n[t]);
      }) : Object.getOwnPropertyDescriptors ? Object.defineProperties(e, Object.getOwnPropertyDescriptors(n)) : vt(Object(n)).forEach(function (t) {
        Object.defineProperty(e, t, Object.getOwnPropertyDescriptor(n, t));
      });
    }
    return e;
  }
  var yt = class extends Error {
    constructor(e, t = `storage`, n, r) {
      super(e), this.__isStorageError = !0, this.namespace = t, this.name = t === `vectors` ? `StorageVectorsError` : `StorageError`, this.status = n, this.statusCode = r;
    }
    toJSON() {
      return {
        name: this.name,
        message: this.message,
        status: this.status,
        statusCode: this.statusCode
      };
    }
  };
  function bt(e) {
    return typeof e == `object` && !!e && `__isStorageError` in e;
  }
  var xt = class extends yt {
      constructor(e, t, n, r = `storage`) {
        super(e, r, t, n), this.name = r === `vectors` ? `StorageVectorsApiError` : `StorageApiError`, this.status = t, this.statusCode = n;
      }
      toJSON() {
        return O({}, super.toJSON());
      }
    },
    St = class extends yt {
      constructor(e, t, n = `storage`) {
        super(e, n), this.name = n === `vectors` ? `StorageVectorsUnknownError` : `StorageUnknownError`, this.originalError = t;
      }
    };
  function Ct(e, t, n) {
    var r = O({}, e),
      i = t.toLowerCase();
    for (var _i0 = 0, _Object$keys = Object.keys(r); _i0 < _Object$keys.length; _i0++) {
      var _e19 = _Object$keys[_i0];
      _e19.toLowerCase() === i && delete r[_e19];
    }
    return r[i] = n, r;
  }
  function wt(e) {
    var t = {};
    for (var _i1 = 0, _Object$entries3 = Object.entries(e); _i1 < _Object$entries3.length; _i1++) {
      var _Object$entries3$_i = _slicedToArray(_Object$entries3[_i1], 2),
        n = _Object$entries3$_i[0],
        r = _Object$entries3$_i[1];
      t[n.toLowerCase()] = r;
    }
    return t;
  }
  var Tt = e => e ? (...t) => e(...t) : (...e) => fetch(...e),
    Et = e => {
      if (typeof e != `object` || !e) return !1;
      var t = Object.getPrototypeOf(e);
      return (t === null || t === Object.prototype || Object.getPrototypeOf(t) === null) && !(Symbol.toStringTag in e) && !(Symbol.iterator in e);
    },
    Dt = e => {
      if (Array.isArray(e)) return e.map(e => Dt(e));
      if (typeof e == `function` || e !== Object(e)) return e;
      var t = {};
      return Object.entries(e).forEach(([e, n]) => {
        var r = e.replace(/([-_][a-z])/gi, e => e.toUpperCase().replace(/[-_]/g, ``));
        t[r] = Dt(n);
      }), t;
    },
    Ot = e => !e || typeof e != `string` || e.length === 0 || e.length > 100 || e.trim() !== e || e.includes(`/`) || e.includes(`\\`) ? !1 : /^[\w!.\*'() &$@=;:+,?-]+$/.test(e),
    kt = e => {
      if (typeof e == `object` && e) {
        var t = e;
        if (typeof t.msg == `string`) return t.msg;
        if (typeof t.message == `string`) return t.message;
        if (typeof t.error_description == `string`) return t.error_description;
        if (typeof t.error == `string`) return t.error;
        if (typeof t.error == `object` && t.error !== null) {
          var _e20 = t.error;
          if (typeof _e20.message == `string`) return _e20.message;
        }
      }
      return JSON.stringify(e);
    },
    At = /*#__PURE__*/function () {
      var _At = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee46(e, t, n, r) {
        var _n0, i;
        return _regenerator().w(function (_context47) {
          while (1) switch (_context47.n) {
            case 0:
              if (typeof e == `object` && e && `json` in e && typeof e.json == `function`) {
                _n0 = e, i = parseInt(String(_n0.status), 10);
                Number.isFinite(i) || (i = 500), _n0.json().then(e => {
                  var n = (e === null || e === void 0 ? void 0 : e.statusCode) || (e === null || e === void 0 ? void 0 : e.code) || i + ``;
                  t(new xt(kt(e), i, n, r));
                }).catch(() => {
                  var e = i + ``;
                  t(new xt(_n0.statusText || `HTTP ${i} error`, i, e, r));
                });
              } else t(new St(kt(e), e, r));
            case 1:
              return _context47.a(2);
          }
        }, _callee46);
      }));
      function At(_x9, _x0, _x1, _x10) {
        return _At.apply(this, arguments);
      }
      return At;
    }(),
    jt = (e, t, n, r) => {
      var i = {
        method: e,
        headers: (t === null || t === void 0 ? void 0 : t.headers) || {}
      };
      if (e === `GET` || e === `HEAD` || !r) return O(O({}, i), n);
      if (Et(r)) {
        var _e21 = (t === null || t === void 0 ? void 0 : t.headers) || {},
          _n1;
        for (var _i10 = 0, _Object$entries4 = Object.entries(_e21); _i10 < _Object$entries4.length; _i10++) {
          var _Object$entries4$_i = _slicedToArray(_Object$entries4[_i10], 2),
            _t29 = _Object$entries4$_i[0],
            _r7 = _Object$entries4$_i[1];
          _t29.toLowerCase() === `content-type` && (_n1 = _r7);
        }
        i.headers = Ct(_e21, `Content-Type`, _n1 !== null && _n1 !== void 0 ? _n1 : `application/json`), i.body = JSON.stringify(r);
      } else i.body = r;
      return t !== null && t !== void 0 && t.duplex && (i.duplex = t.duplex), O(O({}, i), n);
    };
  function Mt(_x11, _x12, _x13, _x14, _x15, _x16, _x17) {
    return _Mt.apply(this, arguments);
  }
  function _Mt() {
    _Mt = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee309(e, t, n, r, i, a, o) {
      return _regenerator().w(function (_context310) {
        while (1) switch (_context310.n) {
          case 0:
            return _context310.a(2, new Promise((s, c) => {
              e(n, jt(t, r, i, a)).then(e => {
                if (!e.ok) throw e;
                if (r !== null && r !== void 0 && r.noResolveJson) return e;
                if (o === `vectors`) {
                  var _t264 = e.headers.get(`content-type`);
                  if (e.headers.get(`content-length`) === `0` || e.status === 204 || !_t264 || !_t264.includes(`application/json`)) return {};
                }
                return e.json();
              }).then(e => s(e)).catch(e => At(e, c, r, o));
            }));
        }
      }, _callee309);
    }));
    return _Mt.apply(this, arguments);
  }
  function Nt(e = `storage`) {
    return {
      get: function () {
        var _get = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee47(t, n, r, i) {
          return _regenerator().w(function (_context48) {
            while (1) switch (_context48.n) {
              case 0:
                return _context48.a(2, Mt(t, `GET`, n, r, i, void 0, e));
            }
          }, _callee47);
        }));
        function get(_x18, _x19, _x20, _x21) {
          return _get.apply(this, arguments);
        }
        return get;
      }(),
      post: function () {
        var _post = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee48(t, n, r, i, a) {
          return _regenerator().w(function (_context49) {
            while (1) switch (_context49.n) {
              case 0:
                return _context49.a(2, Mt(t, `POST`, n, i, a, r, e));
            }
          }, _callee48);
        }));
        function post(_x22, _x23, _x24, _x25, _x26) {
          return _post.apply(this, arguments);
        }
        return post;
      }(),
      put: function () {
        var _put = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee49(t, n, r, i, a) {
          return _regenerator().w(function (_context50) {
            while (1) switch (_context50.n) {
              case 0:
                return _context50.a(2, Mt(t, `PUT`, n, i, a, r, e));
            }
          }, _callee49);
        }));
        function put(_x27, _x28, _x29, _x30, _x31) {
          return _put.apply(this, arguments);
        }
        return put;
      }(),
      head: function () {
        var _head = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee50(t, n, r, i) {
          return _regenerator().w(function (_context51) {
            while (1) switch (_context51.n) {
              case 0:
                return _context51.a(2, Mt(t, `HEAD`, n, O(O({}, r), {}, {
                  noResolveJson: !0
                }), i, void 0, e));
            }
          }, _callee50);
        }));
        function head(_x32, _x33, _x34, _x35) {
          return _head.apply(this, arguments);
        }
        return head;
      }(),
      remove: function () {
        var _remove = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee51(t, n, r, i, a) {
          return _regenerator().w(function (_context52) {
            while (1) switch (_context52.n) {
              case 0:
                return _context52.a(2, Mt(t, `DELETE`, n, i, a, r, e));
            }
          }, _callee51);
        }));
        function remove(_x36, _x37, _x38, _x39, _x40) {
          return _remove.apply(this, arguments);
        }
        return remove;
      }()
    };
  }
  var _Nt = Nt(`storage`),
    Pt = _Nt.get,
    k = _Nt.post,
    Ft = _Nt.put,
    It = _Nt.head,
    Lt = _Nt.remove,
    A = Nt(`vectors`);
  var j = class {
    constructor(e, t = {}, n, r = `storage`) {
      this.shouldThrowOnError = !1, this.url = e, this.headers = wt(t), this.fetch = Tt(n), this.namespace = r;
    }
    throwOnError() {
      return this.shouldThrowOnError = !0, this;
    }
    setHeader(e, t) {
      return this.headers = Ct(this.headers, e, t), this;
    }
    handleOperation(e) {
      var _this41 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee52() {
        var t, _t30, _t31;
        return _regenerator().w(function (_context53) {
          while (1) switch (_context53.p = _context53.n) {
            case 0:
              t = _this41;
              _context53.p = 1;
              _context53.n = 2;
              return e();
            case 2:
              _t30 = _context53.v;
              return _context53.a(2, {
                data: _t30,
                error: null
              });
            case 3:
              _context53.p = 3;
              _t31 = _context53.v;
              if (!t.shouldThrowOnError) {
                _context53.n = 4;
                break;
              }
              throw _t31;
            case 4:
              if (!bt(_t31)) {
                _context53.n = 5;
                break;
              }
              return _context53.a(2, {
                data: null,
                error: _t31
              });
            case 5:
              throw _t31;
            case 6:
              return _context53.a(2);
          }
        }, _callee52, null, [[1, 3]]);
      }))();
    }
  };
  var Rt;
  Rt = Symbol.toStringTag;
  var zt = class {
    constructor(e, t) {
      this.downloadFn = e, this.shouldThrowOnError = t, this[Rt] = `StreamDownloadBuilder`, this.promise = null;
    }
    then(e, t) {
      return this.getPromise().then(e, t);
    }
    catch(e) {
      return this.getPromise().catch(e);
    }
    finally(e) {
      return this.getPromise().finally(e);
    }
    getPromise() {
      return this.promise || (this.promise = this.execute()), this.promise;
    }
    execute() {
      var _this42 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee53() {
        var e, _t32, _t33;
        return _regenerator().w(function (_context54) {
          while (1) switch (_context54.p = _context54.n) {
            case 0:
              e = _this42;
              _context54.p = 1;
              _context54.n = 2;
              return e.downloadFn();
            case 2:
              _t32 = _context54.v.body;
              return _context54.a(2, {
                data: _t32,
                error: null
              });
            case 3:
              _context54.p = 3;
              _t33 = _context54.v;
              if (!e.shouldThrowOnError) {
                _context54.n = 4;
                break;
              }
              throw _t33;
            case 4:
              if (!bt(_t33)) {
                _context54.n = 5;
                break;
              }
              return _context54.a(2, {
                data: null,
                error: _t33
              });
            case 5:
              throw _t33;
            case 6:
              return _context54.a(2);
          }
        }, _callee53, null, [[1, 3]]);
      }))();
    }
  };
  var Bt;
  Bt = Symbol.toStringTag;
  var Vt = class {
    constructor(e, t) {
      this.downloadFn = e, this.shouldThrowOnError = t, this[Bt] = `BlobDownloadBuilder`, this.promise = null;
    }
    asStream() {
      return new zt(this.downloadFn, this.shouldThrowOnError);
    }
    then(e, t) {
      return this.getPromise().then(e, t);
    }
    catch(e) {
      return this.getPromise().catch(e);
    }
    finally(e) {
      return this.getPromise().finally(e);
    }
    getPromise() {
      return this.promise || (this.promise = this.execute()), this.promise;
    }
    execute() {
      var _this43 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee54() {
        var e, _t34, _t35;
        return _regenerator().w(function (_context55) {
          while (1) switch (_context55.p = _context55.n) {
            case 0:
              e = _this43;
              _context55.p = 1;
              _context55.n = 2;
              return e.downloadFn();
            case 2:
              _context55.n = 3;
              return _context55.v.blob();
            case 3:
              _t34 = _context55.v;
              return _context55.a(2, {
                data: _t34,
                error: null
              });
            case 4:
              _context55.p = 4;
              _t35 = _context55.v;
              if (!e.shouldThrowOnError) {
                _context55.n = 5;
                break;
              }
              throw _t35;
            case 5:
              if (!bt(_t35)) {
                _context55.n = 6;
                break;
              }
              return _context55.a(2, {
                data: null,
                error: _t35
              });
            case 6:
              throw _t35;
            case 7:
              return _context55.a(2);
          }
        }, _callee54, null, [[1, 4]]);
      }))();
    }
  };
  var Ht = {
      limit: 100,
      offset: 0,
      sortBy: {
        column: `name`,
        order: `asc`
      }
    },
    Ut = {
      cacheControl: `3600`,
      contentType: `text/plain;charset=UTF-8`,
      upsert: !1
    };
  var Wt = class extends j {
    constructor(e, t = {}, n, r) {
      super(e, t, r, `storage`), this.bucketId = n;
    }
    uploadOrUpdate(e, t, n, r) {
      var _this44 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee56() {
        var i;
        return _regenerator().w(function (_context57) {
          while (1) switch (_context57.n) {
            case 0:
              i = _this44;
              return _context57.a(2, i.handleOperation(/*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee55() {
                var a, o, s, c, _i11, _Object$entries5, _Object$entries5$_i, _e22, _t36, l, u, d;
                return _regenerator().w(function (_context56) {
                  while (1) switch (_context56.n) {
                    case 0:
                      o = O(O({}, Ut), r), s = O(O({}, i.headers), e === `POST` && {
                        "x-upsert": String(o.upsert)
                      }), c = o.metadata;
                      if (typeof Blob < `u` && n instanceof Blob ? (a = new FormData(), a.append(`cacheControl`, o.cacheControl), c && a.append(`metadata`, i.encodeMetadata(c)), a.append(``, n)) : typeof FormData < `u` && n instanceof FormData ? (a = n, a.has(`cacheControl`) || a.append(`cacheControl`, o.cacheControl), c && !a.has(`metadata`) && a.append(`metadata`, i.encodeMetadata(c))) : (a = n, s[`cache-control`] = `max-age=${o.cacheControl}`, s[`content-type`] = o.contentType, c && (s[`x-metadata`] = i.toBase64(i.encodeMetadata(c))), (typeof ReadableStream < `u` && a instanceof ReadableStream || a && typeof a == `object` && `pipe` in a && typeof a.pipe == `function`) && !o.duplex && (o.duplex = `half`)), r !== null && r !== void 0 && r.headers) for (_i11 = 0, _Object$entries5 = Object.entries(r.headers); _i11 < _Object$entries5.length; _i11++) {
                        _Object$entries5$_i = _slicedToArray(_Object$entries5[_i11], 2), _e22 = _Object$entries5$_i[0], _t36 = _Object$entries5$_i[1];
                        s = Ct(s, _e22, _t36);
                      }
                      l = i._removeEmptyFolders(t);
                      u = i._getFinalPath(l);
                      _context56.n = 1;
                      return (e == `PUT` ? Ft : k)(i.fetch, `${i.url}/object/${u}`, a, O({
                        headers: s
                      }, o !== null && o !== void 0 && o.duplex ? {
                        duplex: o.duplex
                      } : {}));
                    case 1:
                      d = _context56.v;
                      return _context56.a(2, {
                        path: l,
                        id: d.Id,
                        fullPath: d.Key
                      });
                  }
                }, _callee55);
              }))));
          }
        }, _callee56);
      }))();
    }
    upload(e, t, n) {
      var _this45 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee57() {
        return _regenerator().w(function (_context58) {
          while (1) switch (_context58.n) {
            case 0:
              return _context58.a(2, _this45.uploadOrUpdate(`POST`, e, t, n));
          }
        }, _callee57);
      }))();
    }
    uploadToSignedUrl(e, t, n, r) {
      var _this46 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee59() {
        var i, a, o, s;
        return _regenerator().w(function (_context60) {
          while (1) switch (_context60.n) {
            case 0:
              i = _this46;
              a = i._removeEmptyFolders(e), o = i._getFinalPath(a), s = new URL(i.url + `/object/upload/sign/${o}`);
              return _context60.a(2, (s.searchParams.set(`token`, t), i.handleOperation(/*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee58() {
                var e, t, o, c, _i12, _Object$entries6, _Object$entries6$_i, _e23, _t37, _t38, _t39;
                return _regenerator().w(function (_context59) {
                  while (1) switch (_context59.n) {
                    case 0:
                      t = O(O({}, Ut), r), o = O(O({}, i.headers), {
                        "x-upsert": String(t.upsert)
                      }), c = t.metadata;
                      if (typeof Blob < `u` && n instanceof Blob ? (e = new FormData(), e.append(`cacheControl`, t.cacheControl), c && e.append(`metadata`, i.encodeMetadata(c)), e.append(``, n)) : typeof FormData < `u` && n instanceof FormData ? (e = n, e.has(`cacheControl`) || e.append(`cacheControl`, t.cacheControl), c && !e.has(`metadata`) && e.append(`metadata`, i.encodeMetadata(c))) : (e = n, o[`cache-control`] = `max-age=${t.cacheControl}`, o[`content-type`] = t.contentType, c && (o[`x-metadata`] = i.toBase64(i.encodeMetadata(c))), (typeof ReadableStream < `u` && e instanceof ReadableStream || e && typeof e == `object` && `pipe` in e && typeof e.pipe == `function`) && !t.duplex && (t.duplex = `half`)), r !== null && r !== void 0 && r.headers) for (_i12 = 0, _Object$entries6 = Object.entries(r.headers); _i12 < _Object$entries6.length; _i12++) {
                        _Object$entries6$_i = _slicedToArray(_Object$entries6[_i12], 2), _e23 = _Object$entries6$_i[0], _t37 = _Object$entries6$_i[1];
                        o = Ct(o, _e23, _t37);
                      }
                      _t38 = a;
                      _context59.n = 1;
                      return Ft(i.fetch, s.toString(), e, O({
                        headers: o
                      }, t !== null && t !== void 0 && t.duplex ? {
                        duplex: t.duplex
                      } : {}));
                    case 1:
                      _t39 = _context59.v.Key;
                      return _context59.a(2, {
                        path: _t38,
                        fullPath: _t39
                      });
                  }
                }, _callee58);
              })))));
          }
        }, _callee59);
      }))();
    }
    createSignedUploadUrl(e, t) {
      var _this47 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee61() {
        var n;
        return _regenerator().w(function (_context62) {
          while (1) switch (_context62.n) {
            case 0:
              n = _this47;
              return _context62.a(2, n.handleOperation(/*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee60() {
                var r, i, a, o, s;
                return _regenerator().w(function (_context61) {
                  while (1) switch (_context61.n) {
                    case 0:
                      r = n._getFinalPath(e), i = O({}, n.headers);
                      (t === null || t === void 0 ? void 0 : t.upsert) && (i[`x-upsert`] = `true`);
                      _context61.n = 1;
                      return k(n.fetch, `${n.url}/object/upload/sign/${r}`, {}, {
                        headers: i
                      });
                    case 1:
                      a = _context61.v;
                      o = new URL(n.url + a.url);
                      s = o.searchParams.get(`token`);
                      if (s) {
                        _context61.n = 2;
                        break;
                      }
                      throw new yt(`No token returned by API`);
                    case 2:
                      return _context61.a(2, {
                        signedUrl: o.toString(),
                        path: e,
                        token: s
                      });
                  }
                }, _callee60);
              }))));
          }
        }, _callee61);
      }))();
    }
    update(e, t, n) {
      var _this48 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee62() {
        return _regenerator().w(function (_context63) {
          while (1) switch (_context63.n) {
            case 0:
              return _context63.a(2, _this48.uploadOrUpdate(`PUT`, e, t, n));
          }
        }, _callee62);
      }))();
    }
    move(e, t, n) {
      var _this49 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee64() {
        var r;
        return _regenerator().w(function (_context65) {
          while (1) switch (_context65.n) {
            case 0:
              r = _this49;
              return _context65.a(2, r.handleOperation(/*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee63() {
                return _regenerator().w(function (_context64) {
                  while (1) switch (_context64.n) {
                    case 0:
                      _context64.n = 1;
                      return k(r.fetch, `${r.url}/object/move`, {
                        bucketId: r.bucketId,
                        sourceKey: e,
                        destinationKey: t,
                        destinationBucket: n === null || n === void 0 ? void 0 : n.destinationBucket
                      }, {
                        headers: r.headers
                      });
                    case 1:
                      return _context64.a(2, _context64.v);
                  }
                }, _callee63);
              }))));
          }
        }, _callee64);
      }))();
    }
    copy(e, t, n) {
      var _this50 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee66() {
        var r;
        return _regenerator().w(function (_context67) {
          while (1) switch (_context67.n) {
            case 0:
              r = _this50;
              return _context67.a(2, r.handleOperation(/*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee65() {
                var _t40;
                return _regenerator().w(function (_context66) {
                  while (1) switch (_context66.n) {
                    case 0:
                      _context66.n = 1;
                      return k(r.fetch, `${r.url}/object/copy`, {
                        bucketId: r.bucketId,
                        sourceKey: e,
                        destinationKey: t,
                        destinationBucket: n === null || n === void 0 ? void 0 : n.destinationBucket
                      }, {
                        headers: r.headers
                      });
                    case 1:
                      _t40 = _context66.v.Key;
                      return _context66.a(2, {
                        path: _t40
                      });
                  }
                }, _callee65);
              }))));
          }
        }, _callee66);
      }))();
    }
    createSignedUrl(e, t, n) {
      var _this51 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee68() {
        var r;
        return _regenerator().w(function (_context69) {
          while (1) switch (_context69.n) {
            case 0:
              r = _this51;
              return _context69.a(2, r.handleOperation(/*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee67() {
                var i, a, o, s, c;
                return _regenerator().w(function (_context68) {
                  while (1) switch (_context68.n) {
                    case 0:
                      i = r._getFinalPath(e);
                      a = typeof (n === null || n === void 0 ? void 0 : n.transform) == `object` && n.transform !== null && Object.keys(n.transform).length > 0;
                      _context68.n = 1;
                      return k(r.fetch, `${r.url}/object/sign/${i}`, O({
                        expiresIn: t
                      }, a ? {
                        transform: n.transform
                      } : {}), {
                        headers: r.headers
                      });
                    case 1:
                      o = _context68.v;
                      s = new URLSearchParams();
                      n !== null && n !== void 0 && n.download && s.set(`download`, n.download === !0 ? `` : n.download), (n === null || n === void 0 ? void 0 : n.cacheNonce) != null && s.set(`cacheNonce`, String(n.cacheNonce));
                      c = s.toString();
                      return _context68.a(2, {
                        signedUrl: encodeURI(`${r.url}${o.signedURL}${c ? `&${c}` : ``}`)
                      });
                  }
                }, _callee67);
              }))));
          }
        }, _callee68);
      }))();
    }
    createSignedUrls(e, t, n) {
      var _this52 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee70() {
        var r;
        return _regenerator().w(function (_context71) {
          while (1) switch (_context71.n) {
            case 0:
              r = _this52;
              return _context71.a(2, r.handleOperation(/*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee69() {
                var i, a, o;
                return _regenerator().w(function (_context70) {
                  while (1) switch (_context70.n) {
                    case 0:
                      _context70.n = 1;
                      return k(r.fetch, `${r.url}/object/sign/${r.bucketId}`, {
                        expiresIn: t,
                        paths: e
                      }, {
                        headers: r.headers
                      });
                    case 1:
                      i = _context70.v;
                      a = new URLSearchParams();
                      n !== null && n !== void 0 && n.download && a.set(`download`, n.download === !0 ? `` : n.download), (n === null || n === void 0 ? void 0 : n.cacheNonce) != null && a.set(`cacheNonce`, String(n.cacheNonce));
                      o = a.toString();
                      return _context70.a(2, i.map(e => O(O({}, e), {}, {
                        signedUrl: e.signedURL ? encodeURI(`${r.url}${e.signedURL}${o ? `&${o}` : ``}`) : null
                      })));
                  }
                }, _callee69);
              }))));
          }
        }, _callee70);
      }))();
    }
    download(e, t, n) {
      var r = typeof (t === null || t === void 0 ? void 0 : t.transform) == `object` && t.transform !== null && Object.keys(t.transform).length > 0 ? `render/image/authenticated` : `object`,
        i = new URLSearchParams();
      t !== null && t !== void 0 && t.transform && this.applyTransformOptsToQuery(i, t.transform), (t === null || t === void 0 ? void 0 : t.cacheNonce) != null && i.set(`cacheNonce`, String(t.cacheNonce));
      var a = i.toString(),
        o = this._getFinalPath(e);
      return new Vt(() => Pt(this.fetch, `${this.url}/${r}/${o}${a ? `?${a}` : ``}`, {
        headers: this.headers,
        noResolveJson: !0
      }, n), this.shouldThrowOnError);
    }
    info(e) {
      var _this53 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee72() {
        var t, n;
        return _regenerator().w(function (_context73) {
          while (1) switch (_context73.n) {
            case 0:
              t = _this53;
              n = t._getFinalPath(e);
              return _context73.a(2, t.handleOperation(/*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee71() {
                var _t41;
                return _regenerator().w(function (_context72) {
                  while (1) switch (_context72.n) {
                    case 0:
                      _t41 = Dt;
                      _context72.n = 1;
                      return Pt(t.fetch, `${t.url}/object/info/${n}`, {
                        headers: t.headers
                      });
                    case 1:
                      return _context72.a(2, _t41(_context72.v));
                  }
                }, _callee71);
              }))));
          }
        }, _callee72);
      }))();
    }
    exists(e) {
      var _this54 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee73() {
        var t, n, _e$originalError, _t42, _t43;
        return _regenerator().w(function (_context74) {
          while (1) switch (_context74.p = _context74.n) {
            case 0:
              t = _this54;
              n = t._getFinalPath(e);
              _context74.p = 1;
              _context74.n = 2;
              return It(t.fetch, `${t.url}/object/${n}`, {
                headers: t.headers
              });
            case 2:
              return _context74.a(2, {
                data: !0,
                error: null
              });
            case 3:
              _context74.p = 3;
              _t43 = _context74.v;
              if (!t.shouldThrowOnError) {
                _context74.n = 4;
                break;
              }
              throw _t43;
            case 4:
              if (!bt(_t43)) {
                _context74.n = 5;
                break;
              }
              _t42 = _t43 instanceof xt ? _t43.status : _t43 instanceof St ? (_e$originalError = _t43.originalError) === null || _e$originalError === void 0 ? void 0 : _e$originalError.status : void 0;
              if (!(_t42 !== void 0 && [400, 404].includes(_t42))) {
                _context74.n = 5;
                break;
              }
              return _context74.a(2, {
                data: !1,
                error: _t43
              });
            case 5:
              throw _t43;
            case 6:
              return _context74.a(2);
          }
        }, _callee73, null, [[1, 3]]);
      }))();
    }
    getPublicUrl(e, t) {
      var n = this._getFinalPath(e),
        r = new URLSearchParams();
      t !== null && t !== void 0 && t.download && r.set(`download`, t.download === !0 ? `` : t.download), t !== null && t !== void 0 && t.transform && this.applyTransformOptsToQuery(r, t.transform), (t === null || t === void 0 ? void 0 : t.cacheNonce) != null && r.set(`cacheNonce`, String(t.cacheNonce));
      var i = r.toString(),
        a = typeof (t === null || t === void 0 ? void 0 : t.transform) == `object` && t.transform !== null && Object.keys(t.transform).length > 0 ? `render/image` : `object`;
      return {
        data: {
          publicUrl: encodeURI(`${this.url}/${a}/public/${n}`) + (i ? `?${i}` : ``)
        }
      };
    }
    remove(e) {
      var _this55 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee75() {
        var t;
        return _regenerator().w(function (_context76) {
          while (1) switch (_context76.n) {
            case 0:
              t = _this55;
              return _context76.a(2, t.handleOperation(/*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee74() {
                return _regenerator().w(function (_context75) {
                  while (1) switch (_context75.n) {
                    case 0:
                      _context75.n = 1;
                      return Lt(t.fetch, `${t.url}/object/${t.bucketId}`, {
                        prefixes: e
                      }, {
                        headers: t.headers
                      });
                    case 1:
                      return _context75.a(2, _context75.v);
                  }
                }, _callee74);
              }))));
          }
        }, _callee75);
      }))();
    }
    list(e, t, n) {
      var _this56 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee77() {
        var r;
        return _regenerator().w(function (_context78) {
          while (1) switch (_context78.n) {
            case 0:
              r = _this56;
              return _context78.a(2, r.handleOperation(/*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee76() {
                var i;
                return _regenerator().w(function (_context77) {
                  while (1) switch (_context77.n) {
                    case 0:
                      i = O(O(O({}, Ht), t), {}, {
                        prefix: e || ``
                      });
                      _context77.n = 1;
                      return k(r.fetch, `${r.url}/object/list/${r.bucketId}`, i, {
                        headers: r.headers
                      }, n);
                    case 1:
                      return _context77.a(2, _context77.v);
                  }
                }, _callee76);
              }))));
          }
        }, _callee77);
      }))();
    }
    listV2(e, t) {
      var _this57 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee79() {
        var n;
        return _regenerator().w(function (_context80) {
          while (1) switch (_context80.n) {
            case 0:
              n = _this57;
              return _context80.a(2, n.handleOperation(/*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee78() {
                var r;
                return _regenerator().w(function (_context79) {
                  while (1) switch (_context79.n) {
                    case 0:
                      r = O({}, e);
                      _context79.n = 1;
                      return k(n.fetch, `${n.url}/object/list-v2/${n.bucketId}`, r, {
                        headers: n.headers
                      }, t);
                    case 1:
                      return _context79.a(2, _context79.v);
                  }
                }, _callee78);
              }))));
          }
        }, _callee79);
      }))();
    }
    encodeMetadata(e) {
      return JSON.stringify(e);
    }
    toBase64(e) {
      return typeof Buffer < `u` ? Buffer.from(e).toString(`base64`) : btoa(e);
    }
    _getFinalPath(e) {
      return `${this.bucketId}/${e.replace(/^\/+/, ``)}`;
    }
    _removeEmptyFolders(e) {
      return e.replace(/^\/|\/$/g, ``).replace(/\/+/g, `/`);
    }
    applyTransformOptsToQuery(e, t) {
      return t.width && e.set(`width`, t.width.toString()), t.height && e.set(`height`, t.height.toString()), t.resize && e.set(`resize`, t.resize), t.format && e.set(`format`, t.format), t.quality && e.set(`quality`, t.quality.toString()), e;
    }
  };
  var Gt = {
    "X-Client-Info": `storage-js/2.108.2`
  };
  var Kt = class extends j {
      constructor(e, t = {}, n, r) {
        var i = new URL(e);
        (r === null || r === void 0 ? void 0 : r.useNewHostname) && /supabase\.(co|in|red)$/.test(i.hostname) && !i.hostname.includes(`storage.supabase.`) && (i.hostname = i.hostname.replace(`supabase.`, `storage.supabase.`));
        var a = i.href.replace(/\/$/, ``),
          o = O(O({}, Gt), t);
        super(a, o, n, `storage`);
      }
      listBuckets(e) {
        var _this58 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee81() {
          var t;
          return _regenerator().w(function (_context82) {
            while (1) switch (_context82.n) {
              case 0:
                t = _this58;
                return _context82.a(2, t.handleOperation(/*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee80() {
                  var n;
                  return _regenerator().w(function (_context81) {
                    while (1) switch (_context81.n) {
                      case 0:
                        n = t.listBucketOptionsToQueryString(e);
                        _context81.n = 1;
                        return Pt(t.fetch, `${t.url}/bucket${n}`, {
                          headers: t.headers
                        });
                      case 1:
                        return _context81.a(2, _context81.v);
                    }
                  }, _callee80);
                }))));
            }
          }, _callee81);
        }))();
      }
      getBucket(e) {
        var _this59 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee83() {
          var t;
          return _regenerator().w(function (_context84) {
            while (1) switch (_context84.n) {
              case 0:
                t = _this59;
                return _context84.a(2, t.handleOperation(/*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee82() {
                  return _regenerator().w(function (_context83) {
                    while (1) switch (_context83.n) {
                      case 0:
                        _context83.n = 1;
                        return Pt(t.fetch, `${t.url}/bucket/${e}`, {
                          headers: t.headers
                        });
                      case 1:
                        return _context83.a(2, _context83.v);
                    }
                  }, _callee82);
                }))));
            }
          }, _callee83);
        }))();
      }
      createBucket(_x41) {
        var _this60 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee85(e, t = {
          public: !1
        }) {
          var n;
          return _regenerator().w(function (_context86) {
            while (1) switch (_context86.n) {
              case 0:
                n = _this60;
                return _context86.a(2, n.handleOperation(/*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee84() {
                  return _regenerator().w(function (_context85) {
                    while (1) switch (_context85.n) {
                      case 0:
                        _context85.n = 1;
                        return k(n.fetch, `${n.url}/bucket`, {
                          id: e,
                          name: e,
                          type: t.type,
                          public: t.public,
                          file_size_limit: t.fileSizeLimit,
                          allowed_mime_types: t.allowedMimeTypes
                        }, {
                          headers: n.headers
                        });
                      case 1:
                        return _context85.a(2, _context85.v);
                    }
                  }, _callee84);
                }))));
            }
          }, _callee85);
        })).apply(this, arguments);
      }
      updateBucket(e, t) {
        var _this61 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee87() {
          var n;
          return _regenerator().w(function (_context88) {
            while (1) switch (_context88.n) {
              case 0:
                n = _this61;
                return _context88.a(2, n.handleOperation(/*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee86() {
                  return _regenerator().w(function (_context87) {
                    while (1) switch (_context87.n) {
                      case 0:
                        _context87.n = 1;
                        return Ft(n.fetch, `${n.url}/bucket/${e}`, {
                          id: e,
                          name: e,
                          public: t.public,
                          file_size_limit: t.fileSizeLimit,
                          allowed_mime_types: t.allowedMimeTypes
                        }, {
                          headers: n.headers
                        });
                      case 1:
                        return _context87.a(2, _context87.v);
                    }
                  }, _callee86);
                }))));
            }
          }, _callee87);
        }))();
      }
      emptyBucket(e) {
        var _this62 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee89() {
          var t;
          return _regenerator().w(function (_context90) {
            while (1) switch (_context90.n) {
              case 0:
                t = _this62;
                return _context90.a(2, t.handleOperation(/*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee88() {
                  return _regenerator().w(function (_context89) {
                    while (1) switch (_context89.n) {
                      case 0:
                        _context89.n = 1;
                        return k(t.fetch, `${t.url}/bucket/${e}/empty`, {}, {
                          headers: t.headers
                        });
                      case 1:
                        return _context89.a(2, _context89.v);
                    }
                  }, _callee88);
                }))));
            }
          }, _callee89);
        }))();
      }
      deleteBucket(e) {
        var _this63 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee91() {
          var t;
          return _regenerator().w(function (_context92) {
            while (1) switch (_context92.n) {
              case 0:
                t = _this63;
                return _context92.a(2, t.handleOperation(/*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee90() {
                  return _regenerator().w(function (_context91) {
                    while (1) switch (_context91.n) {
                      case 0:
                        _context91.n = 1;
                        return Lt(t.fetch, `${t.url}/bucket/${e}`, {}, {
                          headers: t.headers
                        });
                      case 1:
                        return _context91.a(2, _context91.v);
                    }
                  }, _callee90);
                }))));
            }
          }, _callee91);
        }))();
      }
      listBucketOptionsToQueryString(e) {
        var t = {};
        return e && (`limit` in e && (t.limit = String(e.limit)), `offset` in e && (t.offset = String(e.offset)), e.search && (t.search = e.search), e.sortColumn && (t.sortColumn = e.sortColumn), e.sortOrder && (t.sortOrder = e.sortOrder)), Object.keys(t).length > 0 ? `?` + new URLSearchParams(t).toString() : ``;
      }
    },
    qt = class extends j {
      constructor(e, t = {}, n) {
        var r = e.replace(/\/$/, ``),
          i = O(O({}, Gt), t);
        super(r, i, n, `storage`);
      }
      createBucket(e) {
        var _this64 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee93() {
          var t;
          return _regenerator().w(function (_context94) {
            while (1) switch (_context94.n) {
              case 0:
                t = _this64;
                return _context94.a(2, t.handleOperation(/*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee92() {
                  return _regenerator().w(function (_context93) {
                    while (1) switch (_context93.n) {
                      case 0:
                        _context93.n = 1;
                        return k(t.fetch, `${t.url}/bucket`, {
                          name: e
                        }, {
                          headers: t.headers
                        });
                      case 1:
                        return _context93.a(2, _context93.v);
                    }
                  }, _callee92);
                }))));
            }
          }, _callee93);
        }))();
      }
      listBuckets(e) {
        var _this65 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee95() {
          var t;
          return _regenerator().w(function (_context96) {
            while (1) switch (_context96.n) {
              case 0:
                t = _this65;
                return _context96.a(2, t.handleOperation(/*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee94() {
                  var n, r, i;
                  return _regenerator().w(function (_context95) {
                    while (1) switch (_context95.n) {
                      case 0:
                        n = new URLSearchParams();
                        (e === null || e === void 0 ? void 0 : e.limit) !== void 0 && n.set(`limit`, e.limit.toString()), (e === null || e === void 0 ? void 0 : e.offset) !== void 0 && n.set(`offset`, e.offset.toString()), e !== null && e !== void 0 && e.sortColumn && n.set(`sortColumn`, e.sortColumn), e !== null && e !== void 0 && e.sortOrder && n.set(`sortOrder`, e.sortOrder), (e === null || e === void 0 ? void 0 : e.search) && n.set(`search`, e.search);
                        r = n.toString(), i = r ? `${t.url}/bucket?${r}` : `${t.url}/bucket`;
                        _context95.n = 1;
                        return Pt(t.fetch, i, {
                          headers: t.headers
                        });
                      case 1:
                        return _context95.a(2, _context95.v);
                    }
                  }, _callee94);
                }))));
            }
          }, _callee95);
        }))();
      }
      deleteBucket(e) {
        var _this66 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee97() {
          var t;
          return _regenerator().w(function (_context98) {
            while (1) switch (_context98.n) {
              case 0:
                t = _this66;
                return _context98.a(2, t.handleOperation(/*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee96() {
                  return _regenerator().w(function (_context97) {
                    while (1) switch (_context97.n) {
                      case 0:
                        _context97.n = 1;
                        return Lt(t.fetch, `${t.url}/bucket/${e}`, {}, {
                          headers: t.headers
                        });
                      case 1:
                        return _context97.a(2, _context97.v);
                    }
                  }, _callee96);
                }))));
            }
          }, _callee97);
        }))();
      }
      from(e) {
        var t = this;
        if (!Ot(e)) throw new yt(`Invalid bucket name: File, folder, and bucket names must follow AWS object key naming guidelines and should avoid the use of any other characters.`);
        var n = new pt({
            baseUrl: this.url,
            catalogName: e,
            auth: {
              type: `custom`,
              getHeaders: function () {
                var _getHeaders = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee98() {
                  return _regenerator().w(function (_context99) {
                    while (1) switch (_context99.n) {
                      case 0:
                        return _context99.a(2, t.headers);
                    }
                  }, _callee98);
                }));
                function getHeaders() {
                  return _getHeaders.apply(this, arguments);
                }
                return getHeaders;
              }()
            },
            fetch: this.fetch
          }),
          r = this.shouldThrowOnError;
        return new Proxy(n, {
          get(e, t) {
            var n = e[t];
            return typeof n == `function` ? /*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee99(...t) {
              var _t44, _t45;
              return _regenerator().w(function (_context100) {
                while (1) switch (_context100.p = _context100.n) {
                  case 0:
                    _context100.p = 0;
                    _context100.n = 1;
                    return n.apply(e, t);
                  case 1:
                    _t44 = _context100.v;
                    return _context100.a(2, {
                      data: _t44,
                      error: null
                    });
                  case 2:
                    _context100.p = 2;
                    _t45 = _context100.v;
                    if (!r) {
                      _context100.n = 3;
                      break;
                    }
                    throw _t45;
                  case 3:
                    return _context100.a(2, {
                      data: null,
                      error: _t45
                    });
                }
              }, _callee99, null, [[0, 2]]);
            })) : n;
          }
        });
      }
    },
    Jt = class extends j {
      constructor(e, t = {}, n) {
        var r = e.replace(/\/$/, ``),
          i = O(O({}, Gt), {}, {
            "Content-Type": `application/json`
          }, t);
        super(r, i, n, `vectors`);
      }
      createIndex(e) {
        var _this67 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee101() {
          var t;
          return _regenerator().w(function (_context102) {
            while (1) switch (_context102.n) {
              case 0:
                t = _this67;
                return _context102.a(2, t.handleOperation(/*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee100() {
                  var _t46;
                  return _regenerator().w(function (_context101) {
                    while (1) switch (_context101.n) {
                      case 0:
                        _context101.n = 1;
                        return A.post(t.fetch, `${t.url}/CreateIndex`, e, {
                          headers: t.headers
                        });
                      case 1:
                        _t46 = _context101.v;
                        if (_t46) {
                          _context101.n = 2;
                          break;
                        }
                        _t46 = {};
                      case 2:
                        return _context101.a(2, _t46);
                    }
                  }, _callee100);
                }))));
            }
          }, _callee101);
        }))();
      }
      getIndex(e, t) {
        var _this68 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee103() {
          var n;
          return _regenerator().w(function (_context104) {
            while (1) switch (_context104.n) {
              case 0:
                n = _this68;
                return _context104.a(2, n.handleOperation(/*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee102() {
                  return _regenerator().w(function (_context103) {
                    while (1) switch (_context103.n) {
                      case 0:
                        _context103.n = 1;
                        return A.post(n.fetch, `${n.url}/GetIndex`, {
                          vectorBucketName: e,
                          indexName: t
                        }, {
                          headers: n.headers
                        });
                      case 1:
                        return _context103.a(2, _context103.v);
                    }
                  }, _callee102);
                }))));
            }
          }, _callee103);
        }))();
      }
      listIndexes(e) {
        var _this69 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee105() {
          var t;
          return _regenerator().w(function (_context106) {
            while (1) switch (_context106.n) {
              case 0:
                t = _this69;
                return _context106.a(2, t.handleOperation(/*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee104() {
                  return _regenerator().w(function (_context105) {
                    while (1) switch (_context105.n) {
                      case 0:
                        _context105.n = 1;
                        return A.post(t.fetch, `${t.url}/ListIndexes`, e, {
                          headers: t.headers
                        });
                      case 1:
                        return _context105.a(2, _context105.v);
                    }
                  }, _callee104);
                }))));
            }
          }, _callee105);
        }))();
      }
      deleteIndex(e, t) {
        var _this70 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee107() {
          var n;
          return _regenerator().w(function (_context108) {
            while (1) switch (_context108.n) {
              case 0:
                n = _this70;
                return _context108.a(2, n.handleOperation(/*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee106() {
                  var _t47;
                  return _regenerator().w(function (_context107) {
                    while (1) switch (_context107.n) {
                      case 0:
                        _context107.n = 1;
                        return A.post(n.fetch, `${n.url}/DeleteIndex`, {
                          vectorBucketName: e,
                          indexName: t
                        }, {
                          headers: n.headers
                        });
                      case 1:
                        _t47 = _context107.v;
                        if (_t47) {
                          _context107.n = 2;
                          break;
                        }
                        _t47 = {};
                      case 2:
                        return _context107.a(2, _t47);
                    }
                  }, _callee106);
                }))));
            }
          }, _callee107);
        }))();
      }
    },
    Yt = class extends j {
      constructor(e, t = {}, n) {
        var r = e.replace(/\/$/, ``),
          i = O(O({}, Gt), {}, {
            "Content-Type": `application/json`
          }, t);
        super(r, i, n, `vectors`);
      }
      putVectors(e) {
        var _this71 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee109() {
          var t;
          return _regenerator().w(function (_context110) {
            while (1) switch (_context110.n) {
              case 0:
                t = _this71;
                if (!(e.vectors.length < 1 || e.vectors.length > 500)) {
                  _context110.n = 1;
                  break;
                }
                throw Error(`Vector batch size must be between 1 and 500 items`);
              case 1:
                return _context110.a(2, t.handleOperation(/*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee108() {
                  var _t48;
                  return _regenerator().w(function (_context109) {
                    while (1) switch (_context109.n) {
                      case 0:
                        _context109.n = 1;
                        return A.post(t.fetch, `${t.url}/PutVectors`, e, {
                          headers: t.headers
                        });
                      case 1:
                        _t48 = _context109.v;
                        if (_t48) {
                          _context109.n = 2;
                          break;
                        }
                        _t48 = {};
                      case 2:
                        return _context109.a(2, _t48);
                    }
                  }, _callee108);
                }))));
            }
          }, _callee109);
        }))();
      }
      getVectors(e) {
        var _this72 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee111() {
          var t;
          return _regenerator().w(function (_context112) {
            while (1) switch (_context112.n) {
              case 0:
                t = _this72;
                return _context112.a(2, t.handleOperation(/*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee110() {
                  return _regenerator().w(function (_context111) {
                    while (1) switch (_context111.n) {
                      case 0:
                        _context111.n = 1;
                        return A.post(t.fetch, `${t.url}/GetVectors`, e, {
                          headers: t.headers
                        });
                      case 1:
                        return _context111.a(2, _context111.v);
                    }
                  }, _callee110);
                }))));
            }
          }, _callee111);
        }))();
      }
      listVectors(e) {
        var _this73 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee113() {
          var t;
          return _regenerator().w(function (_context114) {
            while (1) switch (_context114.n) {
              case 0:
                t = _this73;
                if (!(e.segmentCount !== void 0)) {
                  _context114.n = 2;
                  break;
                }
                if (!(e.segmentCount < 1 || e.segmentCount > 16)) {
                  _context114.n = 1;
                  break;
                }
                throw Error(`segmentCount must be between 1 and 16`);
              case 1:
                if (!(e.segmentIndex !== void 0 && (e.segmentIndex < 0 || e.segmentIndex >= e.segmentCount))) {
                  _context114.n = 2;
                  break;
                }
                throw Error(`segmentIndex must be between 0 and ${e.segmentCount - 1}`);
              case 2:
                return _context114.a(2, t.handleOperation(/*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee112() {
                  return _regenerator().w(function (_context113) {
                    while (1) switch (_context113.n) {
                      case 0:
                        _context113.n = 1;
                        return A.post(t.fetch, `${t.url}/ListVectors`, e, {
                          headers: t.headers
                        });
                      case 1:
                        return _context113.a(2, _context113.v);
                    }
                  }, _callee112);
                }))));
            }
          }, _callee113);
        }))();
      }
      queryVectors(e) {
        var _this74 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee115() {
          var t;
          return _regenerator().w(function (_context116) {
            while (1) switch (_context116.n) {
              case 0:
                t = _this74;
                return _context116.a(2, t.handleOperation(/*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee114() {
                  return _regenerator().w(function (_context115) {
                    while (1) switch (_context115.n) {
                      case 0:
                        _context115.n = 1;
                        return A.post(t.fetch, `${t.url}/QueryVectors`, e, {
                          headers: t.headers
                        });
                      case 1:
                        return _context115.a(2, _context115.v);
                    }
                  }, _callee114);
                }))));
            }
          }, _callee115);
        }))();
      }
      deleteVectors(e) {
        var _this75 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee117() {
          var t;
          return _regenerator().w(function (_context118) {
            while (1) switch (_context118.n) {
              case 0:
                t = _this75;
                if (!(e.keys.length < 1 || e.keys.length > 500)) {
                  _context118.n = 1;
                  break;
                }
                throw Error(`Keys batch size must be between 1 and 500 items`);
              case 1:
                return _context118.a(2, t.handleOperation(/*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee116() {
                  var _t49;
                  return _regenerator().w(function (_context117) {
                    while (1) switch (_context117.n) {
                      case 0:
                        _context117.n = 1;
                        return A.post(t.fetch, `${t.url}/DeleteVectors`, e, {
                          headers: t.headers
                        });
                      case 1:
                        _t49 = _context117.v;
                        if (_t49) {
                          _context117.n = 2;
                          break;
                        }
                        _t49 = {};
                      case 2:
                        return _context117.a(2, _t49);
                    }
                  }, _callee116);
                }))));
            }
          }, _callee117);
        }))();
      }
    },
    Xt = class extends j {
      constructor(e, t = {}, n) {
        var r = e.replace(/\/$/, ``),
          i = O(O({}, Gt), {}, {
            "Content-Type": `application/json`
          }, t);
        super(r, i, n, `vectors`);
      }
      createBucket(e) {
        var _this76 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee119() {
          var t;
          return _regenerator().w(function (_context120) {
            while (1) switch (_context120.n) {
              case 0:
                t = _this76;
                return _context120.a(2, t.handleOperation(/*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee118() {
                  var _t50;
                  return _regenerator().w(function (_context119) {
                    while (1) switch (_context119.n) {
                      case 0:
                        _context119.n = 1;
                        return A.post(t.fetch, `${t.url}/CreateVectorBucket`, {
                          vectorBucketName: e
                        }, {
                          headers: t.headers
                        });
                      case 1:
                        _t50 = _context119.v;
                        if (_t50) {
                          _context119.n = 2;
                          break;
                        }
                        _t50 = {};
                      case 2:
                        return _context119.a(2, _t50);
                    }
                  }, _callee118);
                }))));
            }
          }, _callee119);
        }))();
      }
      getBucket(e) {
        var _this77 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee121() {
          var t;
          return _regenerator().w(function (_context122) {
            while (1) switch (_context122.n) {
              case 0:
                t = _this77;
                return _context122.a(2, t.handleOperation(/*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee120() {
                  return _regenerator().w(function (_context121) {
                    while (1) switch (_context121.n) {
                      case 0:
                        _context121.n = 1;
                        return A.post(t.fetch, `${t.url}/GetVectorBucket`, {
                          vectorBucketName: e
                        }, {
                          headers: t.headers
                        });
                      case 1:
                        return _context121.a(2, _context121.v);
                    }
                  }, _callee120);
                }))));
            }
          }, _callee121);
        }))();
      }
      listBuckets() {
        var _this78 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee123(e = {}) {
          var t;
          return _regenerator().w(function (_context124) {
            while (1) switch (_context124.n) {
              case 0:
                t = _this78;
                return _context124.a(2, t.handleOperation(/*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee122() {
                  return _regenerator().w(function (_context123) {
                    while (1) switch (_context123.n) {
                      case 0:
                        _context123.n = 1;
                        return A.post(t.fetch, `${t.url}/ListVectorBuckets`, e, {
                          headers: t.headers
                        });
                      case 1:
                        return _context123.a(2, _context123.v);
                    }
                  }, _callee122);
                }))));
            }
          }, _callee123);
        })).apply(this, arguments);
      }
      deleteBucket(e) {
        var _this79 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee125() {
          var t;
          return _regenerator().w(function (_context126) {
            while (1) switch (_context126.n) {
              case 0:
                t = _this79;
                return _context126.a(2, t.handleOperation(/*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee124() {
                  var _t51;
                  return _regenerator().w(function (_context125) {
                    while (1) switch (_context125.n) {
                      case 0:
                        _context125.n = 1;
                        return A.post(t.fetch, `${t.url}/DeleteVectorBucket`, {
                          vectorBucketName: e
                        }, {
                          headers: t.headers
                        });
                      case 1:
                        _t51 = _context125.v;
                        if (_t51) {
                          _context125.n = 2;
                          break;
                        }
                        _t51 = {};
                      case 2:
                        return _context125.a(2, _t51);
                    }
                  }, _callee124);
                }))));
            }
          }, _callee125);
        }))();
      }
    },
    Zt = class extends Xt {
      constructor(e, t = {}) {
        super(e, t.headers || {}, t.fetch);
      }
      from(e) {
        return new Qt(this.url, this.headers, e, this.fetch);
      }
      createBucket(e) {
        var _superprop_getCreateBucket = () => super.createBucket,
          _this80 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee126() {
          var t, n;
          return _regenerator().w(function (_context127) {
            while (1) switch (_context127.n) {
              case 0:
                t = () => _superprop_getCreateBucket(), n = _this80;
                return _context127.a(2, t().call(n, e));
            }
          }, _callee126);
        }))();
      }
      getBucket(e) {
        var _superprop_getGetBucket = () => super.getBucket,
          _this81 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee127() {
          var t, n;
          return _regenerator().w(function (_context128) {
            while (1) switch (_context128.n) {
              case 0:
                t = () => _superprop_getGetBucket(), n = _this81;
                return _context128.a(2, t().call(n, e));
            }
          }, _callee127);
        }))();
      }
      listBuckets() {
        var _superprop_getListBuckets = () => super.listBuckets,
          _this82 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee128(e = {}) {
          var t, n;
          return _regenerator().w(function (_context129) {
            while (1) switch (_context129.n) {
              case 0:
                t = () => _superprop_getListBuckets(), n = _this82;
                return _context129.a(2, t().call(n, e));
            }
          }, _callee128);
        })).apply(this, arguments);
      }
      deleteBucket(e) {
        var _superprop_getDeleteBucket = () => super.deleteBucket,
          _this83 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee129() {
          var t, n;
          return _regenerator().w(function (_context130) {
            while (1) switch (_context130.n) {
              case 0:
                t = () => _superprop_getDeleteBucket(), n = _this83;
                return _context130.a(2, t().call(n, e));
            }
          }, _callee129);
        }))();
      }
    },
    Qt = class extends Jt {
      constructor(e, t, n, r) {
        super(e, t, r), this.vectorBucketName = n;
      }
      createIndex(e) {
        var _superprop_getCreateIndex = () => super.createIndex,
          _this84 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee130() {
          var t, n;
          return _regenerator().w(function (_context131) {
            while (1) switch (_context131.n) {
              case 0:
                t = () => _superprop_getCreateIndex(), n = _this84;
                return _context131.a(2, t().call(n, O(O({}, e), {}, {
                  vectorBucketName: n.vectorBucketName
                })));
            }
          }, _callee130);
        }))();
      }
      listIndexes() {
        var _superprop_getListIndexes = () => super.listIndexes,
          _this85 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee131(e = {}) {
          var t, n;
          return _regenerator().w(function (_context132) {
            while (1) switch (_context132.n) {
              case 0:
                t = () => _superprop_getListIndexes(), n = _this85;
                return _context132.a(2, t().call(n, O(O({}, e), {}, {
                  vectorBucketName: n.vectorBucketName
                })));
            }
          }, _callee131);
        })).apply(this, arguments);
      }
      getIndex(e) {
        var _superprop_getGetIndex = () => super.getIndex,
          _this86 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee132() {
          var t, n;
          return _regenerator().w(function (_context133) {
            while (1) switch (_context133.n) {
              case 0:
                t = () => _superprop_getGetIndex(), n = _this86;
                return _context133.a(2, t().call(n, n.vectorBucketName, e));
            }
          }, _callee132);
        }))();
      }
      deleteIndex(e) {
        var _superprop_getDeleteIndex = () => super.deleteIndex,
          _this87 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee133() {
          var t, n;
          return _regenerator().w(function (_context134) {
            while (1) switch (_context134.n) {
              case 0:
                t = () => _superprop_getDeleteIndex(), n = _this87;
                return _context134.a(2, t().call(n, n.vectorBucketName, e));
            }
          }, _callee133);
        }))();
      }
      index(e) {
        return new $t(this.url, this.headers, this.vectorBucketName, e, this.fetch);
      }
    },
    $t = class extends Yt {
      constructor(e, t, n, r, i) {
        super(e, t, i), this.vectorBucketName = n, this.indexName = r;
      }
      putVectors(e) {
        var _superprop_getPutVectors = () => super.putVectors,
          _this88 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee134() {
          var t, n;
          return _regenerator().w(function (_context135) {
            while (1) switch (_context135.n) {
              case 0:
                t = () => _superprop_getPutVectors(), n = _this88;
                return _context135.a(2, t().call(n, O(O({}, e), {}, {
                  vectorBucketName: n.vectorBucketName,
                  indexName: n.indexName
                })));
            }
          }, _callee134);
        }))();
      }
      getVectors(e) {
        var _superprop_getGetVectors = () => super.getVectors,
          _this89 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee135() {
          var t, n;
          return _regenerator().w(function (_context136) {
            while (1) switch (_context136.n) {
              case 0:
                t = () => _superprop_getGetVectors(), n = _this89;
                return _context136.a(2, t().call(n, O(O({}, e), {}, {
                  vectorBucketName: n.vectorBucketName,
                  indexName: n.indexName
                })));
            }
          }, _callee135);
        }))();
      }
      listVectors() {
        var _superprop_getListVectors = () => super.listVectors,
          _this90 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee136(e = {}) {
          var t, n;
          return _regenerator().w(function (_context137) {
            while (1) switch (_context137.n) {
              case 0:
                t = () => _superprop_getListVectors(), n = _this90;
                return _context137.a(2, t().call(n, O(O({}, e), {}, {
                  vectorBucketName: n.vectorBucketName,
                  indexName: n.indexName
                })));
            }
          }, _callee136);
        })).apply(this, arguments);
      }
      queryVectors(e) {
        var _superprop_getQueryVectors = () => super.queryVectors,
          _this91 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee137() {
          var t, n;
          return _regenerator().w(function (_context138) {
            while (1) switch (_context138.n) {
              case 0:
                t = () => _superprop_getQueryVectors(), n = _this91;
                return _context138.a(2, t().call(n, O(O({}, e), {}, {
                  vectorBucketName: n.vectorBucketName,
                  indexName: n.indexName
                })));
            }
          }, _callee137);
        }))();
      }
      deleteVectors(e) {
        var _superprop_getDeleteVectors = () => super.deleteVectors,
          _this92 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee138() {
          var t, n;
          return _regenerator().w(function (_context139) {
            while (1) switch (_context139.n) {
              case 0:
                t = () => _superprop_getDeleteVectors(), n = _this92;
                return _context139.a(2, t().call(n, O(O({}, e), {}, {
                  vectorBucketName: n.vectorBucketName,
                  indexName: n.indexName
                })));
            }
          }, _callee138);
        }))();
      }
    },
    en = class extends Kt {
      constructor(e, t = {}, n, r) {
        super(e, t, n, r);
      }
      from(e) {
        return new Wt(this.url, this.headers, e, this.fetch);
      }
      get vectors() {
        return new Zt(this.url + `/vector`, {
          headers: this.headers,
          fetch: this.fetch
        });
      }
      get analytics() {
        return new qt(this.url + `/iceberg`, this.headers, this.fetch);
      }
    };
  var tn = ``,
    nn;
  typeof Deno < `u` ? (tn = `deno`, nn = (_Deno$version = Deno.version) === null || _Deno$version === void 0 ? void 0 : _Deno$version.deno) : typeof document < `u` ? tn = `web` : typeof navigator < `u` && navigator.product === `ReactNative` ? tn = `react-native` : (tn = `node`, nn = typeof process < `u` ? (_process$version = process.version) === null || _process$version === void 0 ? void 0 : _process$version.replace(/^v/, ``) : void 0);
  var rn = [`runtime=${tn}`];
  nn && rn.push(`runtime-version=${nn}`);
  var an = {
      headers: {
        "X-Client-Info": `supabase-js/2.108.2; ${rn.join(`; `)}`
      }
    },
    on = {
      schema: `public`
    },
    sn = {
      autoRefreshToken: !0,
      persistSession: !0,
      detectSessionInUrl: !0,
      flowType: `implicit`
    },
    cn = {},
    ln = {
      enabled: !1,
      respectSamplingDecision: !0
    },
    un = null;
  function dn() {
    return un === null && (un = import(`@opentelemetry/api`).catch(() => null)), un;
  }
  function fn() {
    return n(this, void 0, void 0, /*#__PURE__*/_regenerator().m(function _callee139() {
      var _e24, t, n, _t52;
      return _regenerator().w(function (_context140) {
        while (1) switch (_context140.p = _context140.n) {
          case 0:
            _context140.p = 0;
            _context140.n = 1;
            return dn();
          case 1:
            _e24 = _context140.v;
            if (!(!_e24 || !_e24.propagation || !_e24.context)) {
              _context140.n = 2;
              break;
            }
            return _context140.a(2, null);
          case 2:
            t = {};
            _e24.propagation.inject(_e24.context.active(), t);
            n = t.traceparent;
            return _context140.a(2, n ? {
              traceparent: n,
              tracestate: t.tracestate,
              baggage: t.baggage
            } : null);
          case 3:
            _context140.p = 3;
            _t52 = _context140.v;
            return _context140.a(2, null);
        }
      }, _callee139, null, [[0, 3]]);
    }));
  }
  function pn(e) {
    if (!e || typeof e != `string`) return null;
    var t = e.split(`-`);
    if (t.length !== 4) return null;
    var _t53 = _slicedToArray(t, 4),
      n = _t53[0],
      r = _t53[1],
      i = _t53[2],
      a = _t53[3];
    if (n.length !== 2 || r.length !== 32 || i.length !== 16 || a.length !== 2) return null;
    var o = /^[0-9a-f]+$/i;
    return !o.test(n) || !o.test(r) || !o.test(i) || !o.test(a) || r === `00000000000000000000000000000000` || i === `0000000000000000` ? null : {
      version: n,
      traceId: r,
      parentId: i,
      traceFlags: a,
      isSampled: (parseInt(a, 16) & 1) == 1
    };
  }
  function mn(e, t) {
    if (!e || !t || t.length === 0) return !1;
    var n;
    if (e instanceof URL) n = e;else try {
      n = new URL(e);
    } catch (_unused10) {
      return !1;
    }
    var _iterator3 = _createForOfIteratorHelper(t),
      _step3;
    try {
      for (_iterator3.s(); !(_step3 = _iterator3.n()).done;) {
        var _e25 = _step3.value;
        try {
          if (typeof _e25 == `string`) {
            if (hn(n.hostname, _e25)) return !0;
          } else if (_e25 instanceof RegExp) {
            if (_e25.test(n.hostname)) return !0;
          } else if (typeof _e25 == `function` && _e25(n)) return !0;
        } catch (_unused11) {
          continue;
        }
      }
    } catch (err) {
      _iterator3.e(err);
    } finally {
      _iterator3.f();
    }
    return !1;
  }
  function hn(e, t) {
    if (t === e) return !0;
    if (t.startsWith(`*.`)) {
      var n = t.slice(2);
      if (e.endsWith(n) && (e === n || e.endsWith(`.` + n))) return !0;
    }
    return !1;
  }
  function gn(e) {
    var t = [];
    try {
      var n = new URL(e);
      t.push(n.hostname);
    } catch (_unused12) {}
    return t.push(`*.supabase.co`, `*.supabase.in`), t.push(`localhost`, `127.0.0.1`, `[::1]`), t;
  }
  var _n = e => e ? (...t) => e(...t) : (...e) => fetch(...e),
    vn = () => Headers,
    yn = (e, t, n, r, i) => {
      var a = _n(r),
        o = vn(),
        s = (i === null || i === void 0 ? void 0 : i.enabled) === !0,
        c = (i === null || i === void 0 ? void 0 : i.respectSamplingDecision) !== !1,
        l = s ? gn(t) : null;
      return /*#__PURE__*/function () {
        var _ref38 = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee140(t, r) {
          var _yield$n;
          var i, s, _e26, _t54, _t55, _t56;
          return _regenerator().w(function (_context141) {
            while (1) switch (_context141.n) {
              case 0:
                _context141.n = 1;
                return n();
              case 1:
                _t55 = _yield$n = _context141.v;
                _t54 = _t55 !== null;
                if (!_t54) {
                  _context141.n = 2;
                  break;
                }
                _t54 = _yield$n !== void 0;
              case 2:
                if (!_t54) {
                  _context141.n = 3;
                  break;
                }
                _t56 = _yield$n;
                _context141.n = 4;
                break;
              case 3:
                _t56 = e;
              case 4:
                i = _t56;
                s = new o(r === null || r === void 0 ? void 0 : r.headers);
                if (!(s.has(`apikey`) || s.set(`apikey`, e), s.has(`Authorization`) || s.set(`Authorization`, `Bearer ${i}`), l)) {
                  _context141.n = 6;
                  break;
                }
                _context141.n = 5;
                return bn(t, l, c);
              case 5:
                _e26 = _context141.v;
                _e26 && (_e26.traceparent && !s.has(`traceparent`) && s.set(`traceparent`, _e26.traceparent), _e26.tracestate && !s.has(`tracestate`) && s.set(`tracestate`, _e26.tracestate), _e26.baggage && !s.has(`baggage`) && s.set(`baggage`, _e26.baggage));
              case 6:
                return _context141.a(2, a(t, _objectSpread(_objectSpread({}, r), {}, {
                  headers: s
                })));
            }
          }, _callee140);
        }));
        return function (_x42, _x43) {
          return _ref38.apply(this, arguments);
        };
      }();
    };
  function bn(_x44, _x45, _x46) {
    return _bn.apply(this, arguments);
  }
  function _bn() {
    _bn = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee310(e, t, n) {
      var r, _e69;
      return _regenerator().w(function (_context311) {
        while (1) switch (_context311.n) {
          case 0:
            if (mn(typeof e == `string` || e instanceof URL ? e : e.url, t)) {
              _context311.n = 1;
              break;
            }
            return _context311.a(2, null);
          case 1:
            _context311.n = 2;
            return fn();
          case 2:
            r = _context311.v;
            if (!(!r || !r.traceparent)) {
              _context311.n = 3;
              break;
            }
            return _context311.a(2, null);
          case 3:
            if (!n) {
              _context311.n = 4;
              break;
            }
            _e69 = pn(r.traceparent);
            if (!(_e69 && !_e69.isSampled)) {
              _context311.n = 4;
              break;
            }
            return _context311.a(2, null);
          case 4:
            return _context311.a(2, r);
        }
      }, _callee310);
    }));
    return _bn.apply(this, arguments);
  }
  function xn(e) {
    return typeof e == `boolean` ? {
      enabled: e
    } : e;
  }
  function Sn(e) {
    return e.endsWith(`/`) ? e : e + `/`;
  }
  function Cn(e, t) {
    var _l$headers, _a$headers, _ref39, _u$enabled, _ref40, _u$respectSamplingDec;
    var n = e.db,
      r = e.auth,
      i = e.realtime,
      a = e.global,
      o = t.db,
      s = t.auth,
      c = t.realtime,
      l = t.global,
      u = xn(e.tracePropagation),
      d = xn(t.tracePropagation),
      f = {
        db: _objectSpread(_objectSpread({}, o), n),
        auth: _objectSpread(_objectSpread({}, s), r),
        realtime: _objectSpread(_objectSpread({}, c), i),
        storage: {},
        global: _objectSpread(_objectSpread(_objectSpread({}, l), a), {}, {
          headers: _objectSpread(_objectSpread({}, (_l$headers = l === null || l === void 0 ? void 0 : l.headers) !== null && _l$headers !== void 0 ? _l$headers : {}), (_a$headers = a === null || a === void 0 ? void 0 : a.headers) !== null && _a$headers !== void 0 ? _a$headers : {})
        }),
        tracePropagation: {
          enabled: (_ref39 = (_u$enabled = u === null || u === void 0 ? void 0 : u.enabled) !== null && _u$enabled !== void 0 ? _u$enabled : d === null || d === void 0 ? void 0 : d.enabled) !== null && _ref39 !== void 0 ? _ref39 : !1,
          respectSamplingDecision: (_ref40 = (_u$respectSamplingDec = u === null || u === void 0 ? void 0 : u.respectSamplingDecision) !== null && _u$respectSamplingDec !== void 0 ? _u$respectSamplingDec : d === null || d === void 0 ? void 0 : d.respectSamplingDecision) !== null && _ref40 !== void 0 ? _ref40 : !0
        },
        accessToken: function () {
          var _accessToken = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee141() {
            return _regenerator().w(function (_context142) {
              while (1) switch (_context142.n) {
                case 0:
                  return _context142.a(2, ``);
              }
            }, _callee141);
          }));
          function accessToken() {
            return _accessToken.apply(this, arguments);
          }
          return accessToken;
        }()
      };
    return e.accessToken ? f.accessToken = e.accessToken : delete f.accessToken, f;
  }
  function wn(e) {
    var t = e === null || e === void 0 ? void 0 : e.trim();
    if (!t) throw Error(`supabaseUrl is required.`);
    if (!t.match(/^https?:\/\//i)) throw Error(`Invalid supabaseUrl: Must be a valid HTTP or HTTPS URL.`);
    try {
      return new URL(Sn(t));
    } catch (_unused13) {
      throw Error(`Invalid supabaseUrl: Provided URL is malformed.`);
    }
  }
  var Tn = `2.108.2`,
    M = 30 * 1e3,
    En = 3 * M;
  2 * M;
  var Dn = {
      "X-Client-Info": `gotrue-js/${Tn}`
    },
    On = `X-Supabase-Api-Version`,
    kn = {
      "2024-01-01": {
        timestamp: Date.parse(`2024-01-01T00:00:00.0Z`),
        name: `2024-01-01`
      }
    },
    An = /^([a-z0-9_-]{4})*($|[a-z0-9_-]{3}$|[a-z0-9_-]{2}$)$/i;
  var N = class extends Error {
    constructor(e, t, n) {
      super(e), this.__isAuthError = !0, this.name = `AuthError`, this.status = t, this.code = n;
    }
    toJSON() {
      return {
        name: this.name,
        message: this.message,
        status: this.status,
        code: this.code
      };
    }
  };
  function P(e) {
    return typeof e == `object` && !!e && `__isAuthError` in e;
  }
  var jn = class extends N {
    constructor(e, t, n) {
      super(e, t, n), this.name = `AuthApiError`, this.status = t, this.code = n;
    }
  };
  function Mn(e) {
    return P(e) && e.name === `AuthApiError`;
  }
  var F = class extends N {
      constructor(e, t) {
        super(e), this.name = `AuthUnknownError`, this.originalError = t;
      }
    },
    I = class extends N {
      constructor(e, t, n, r) {
        super(e, n, r), this.name = t, this.status = n;
      }
    },
    L = class extends I {
      constructor() {
        super(`Auth session missing!`, `AuthSessionMissingError`, 400, void 0);
      }
    };
  function Nn(e) {
    return P(e) && e.name === `AuthSessionMissingError`;
  }
  var R = class extends I {
      constructor() {
        super(`Auth session or user missing`, `AuthInvalidTokenResponseError`, 500, void 0);
      }
    },
    Pn = class extends I {
      constructor(e) {
        super(e, `AuthInvalidCredentialsError`, 400, void 0);
      }
    },
    Fn = class extends I {
      constructor(e, t = null) {
        super(e, `AuthImplicitGrantRedirectError`, 500, void 0), this.details = null, this.details = t;
      }
      toJSON() {
        return Object.assign(Object.assign({}, super.toJSON()), {
          details: this.details
        });
      }
    };
  function In(e) {
    return P(e) && e.name === `AuthImplicitGrantRedirectError`;
  }
  var Ln = class extends I {
      constructor(e, t = null) {
        super(e, `AuthPKCEGrantCodeExchangeError`, 500, void 0), this.details = null, this.details = t;
      }
      toJSON() {
        return Object.assign(Object.assign({}, super.toJSON()), {
          details: this.details
        });
      }
    },
    Rn = class extends I {
      constructor() {
        super(`PKCE code verifier not found in storage. This can happen if the auth flow was initiated in a different browser or device, or if the storage was cleared. For SSR frameworks (Next.js, SvelteKit, etc.), use @supabase/ssr on both the server and client to store the code verifier in cookies.`, `AuthPKCECodeVerifierMissingError`, 400, `pkce_code_verifier_not_found`);
      }
    };
  function zn(e) {
    return P(e) && e.name === `AuthPKCECodeVerifierMissingError`;
  }
  var Bn = class extends I {
    constructor(e, t) {
      super(e, `AuthRetryableFetchError`, t, void 0);
    }
  };
  function Vn(e) {
    return P(e) && e.name === `AuthRetryableFetchError`;
  }
  var Hn = class extends I {
    constructor(e = `Refresh result discarded: session state changed mid-flight (e.g., concurrent signOut)`) {
      super(e, `AuthRefreshDiscardedError`, 409, void 0);
    }
  };
  function Un(e) {
    return P(e) && e.name === `AuthRefreshDiscardedError`;
  }
  var Wn = class extends I {
    constructor(e, t, n) {
      super(e, `AuthWeakPasswordError`, t, `weak_password`), this.reasons = n;
    }
    toJSON() {
      return Object.assign(Object.assign({}, super.toJSON()), {
        reasons: this.reasons
      });
    }
  };
  function Gn(e) {
    return P(e) && e.name === `AuthWeakPasswordError`;
  }
  var Kn = class extends I {
    constructor(e) {
      super(e, `AuthInvalidJwtError`, 400, `invalid_jwt`);
    }
  };
  var qn = `ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_`.split(``),
    Jn = ` 	
\r=`.split(``),
    Yn = (() => {
      var e = Array(128);
      for (var t = 0; t < e.length; t += 1) e[t] = -1;
      for (var _t57 = 0; _t57 < Jn.length; _t57 += 1) e[Jn[_t57].charCodeAt(0)] = -2;
      for (var _t58 = 0; _t58 < qn.length; _t58 += 1) e[qn[_t58].charCodeAt(0)] = _t58;
      return e;
    })();
  function Xn(e, t, n) {
    if (e !== null) for (t.queue = t.queue << 8 | e, t.queuedBits += 8; t.queuedBits >= 6;) n(qn[t.queue >> t.queuedBits - 6 & 63]), t.queuedBits -= 6;else if (t.queuedBits > 0) for (t.queue <<= 6 - t.queuedBits, t.queuedBits = 6; t.queuedBits >= 6;) n(qn[t.queue >> t.queuedBits - 6 & 63]), t.queuedBits -= 6;
  }
  function Zn(e, t, n) {
    var r = Yn[e];
    if (r > -1) for (t.queue = t.queue << 6 | r, t.queuedBits += 6; t.queuedBits >= 8;) n(t.queue >> t.queuedBits - 8 & 255), t.queuedBits -= 8;else if (r === -2) return;else throw Error(`Invalid Base64-URL character "${String.fromCharCode(e)}"`);
  }
  function Qn(e) {
    var t = [],
      n = e => {
        t.push(String.fromCodePoint(e));
      },
      r = {
        utf8seq: 0,
        codepoint: 0
      },
      i = {
        queue: 0,
        queuedBits: 0
      },
      a = e => {
        tr(e, r, n);
      };
    for (var _t59 = 0; _t59 < e.length; _t59 += 1) Zn(e.charCodeAt(_t59), i, a);
    return t.join(``);
  }
  function $n(e, t) {
    if (e <= 127) {
      t(e);
      return;
    } else if (e <= 2047) {
      t(192 | e >> 6), t(128 | e & 63);
      return;
    } else if (e <= 65535) {
      t(224 | e >> 12), t(128 | e >> 6 & 63), t(128 | e & 63);
      return;
    } else if (e <= 1114111) {
      t(240 | e >> 18), t(128 | e >> 12 & 63), t(128 | e >> 6 & 63), t(128 | e & 63);
      return;
    }
    throw Error(`Unrecognized Unicode codepoint: ${e.toString(16)}`);
  }
  function er(e, t) {
    for (var n = 0; n < e.length; n += 1) {
      var r = e.charCodeAt(n);
      if (r > 55295 && r <= 56319) {
        var _t60 = (r - 55296) * 1024 & 65535;
        r = (e.charCodeAt(n + 1) - 56320 & 65535 | _t60) + 65536, n += 1;
      }
      $n(r, t);
    }
  }
  function tr(e, t, n) {
    if (t.utf8seq === 0) {
      if (e <= 127) {
        n(e);
        return;
      }
      for (var _n10 = 1; _n10 < 6; _n10 += 1) if (!(e >> 7 - _n10 & 1)) {
        t.utf8seq = _n10;
        break;
      }
      if (t.utf8seq === 2) t.codepoint = e & 31;else if (t.utf8seq === 3) t.codepoint = e & 15;else if (t.utf8seq === 4) t.codepoint = e & 7;else throw Error(`Invalid UTF-8 sequence`);
      --t.utf8seq;
    } else if (t.utf8seq > 0) {
      if (e <= 127) throw Error(`Invalid UTF-8 sequence`);
      t.codepoint = t.codepoint << 6 | e & 63, --t.utf8seq, t.utf8seq === 0 && n(t.codepoint);
    }
  }
  function z(e) {
    var t = [],
      n = {
        queue: 0,
        queuedBits: 0
      },
      r = e => {
        t.push(e);
      };
    for (var _t61 = 0; _t61 < e.length; _t61 += 1) Zn(e.charCodeAt(_t61), n, r);
    return new Uint8Array(t);
  }
  function nr(e) {
    var t = [];
    return er(e, e => t.push(e)), new Uint8Array(t);
  }
  function B(e) {
    var t = [],
      n = {
        queue: 0,
        queuedBits: 0
      },
      r = e => {
        t.push(e);
      };
    return e.forEach(e => Xn(e, n, r)), Xn(null, n, r), t.join(``);
  }
  function rr(e) {
    return Math.round(Date.now() / 1e3) + e;
  }
  function ir() {
    return Symbol(`auth-callback`);
  }
  var V = () => typeof window < `u` && typeof document < `u`,
    H = {
      tested: !1,
      writable: !1
    },
    ar = () => {
      if (!V()) return !1;
      try {
        if (typeof globalThis.localStorage != `object`) return !1;
      } catch (_unused14) {
        return !1;
      }
      if (H.tested) return H.writable;
      var e = `lswt-${Math.random()}${Math.random()}`;
      try {
        globalThis.localStorage.setItem(e, e), globalThis.localStorage.removeItem(e), H.tested = !0, H.writable = !0;
      } catch (_unused15) {
        H.tested = !0, H.writable = !1;
      }
      return H.writable;
    };
  function or(e) {
    var t = {},
      n = new URL(e);
    if (n.hash && n.hash[0] === `#`) try {
      new URLSearchParams(n.hash.substring(1)).forEach((e, n) => {
        t[n] = e;
      });
    } catch (_unused16) {}
    return n.searchParams.forEach((e, n) => {
      t[n] = e;
    }), t;
  }
  var sr = e => e ? (...t) => e(...t) : (...e) => fetch(...e),
    cr = e => typeof e == `object` && !!e && `status` in e && `ok` in e && `json` in e && typeof e.json == `function`,
    lr = /*#__PURE__*/function () {
      var _lr = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee142(e, t, n) {
        return _regenerator().w(function (_context143) {
          while (1) switch (_context143.n) {
            case 0:
              _context143.n = 1;
              return e.setItem(t, JSON.stringify(n));
            case 1:
              return _context143.a(2);
          }
        }, _callee142);
      }));
      function lr(_x47, _x48, _x49) {
        return _lr.apply(this, arguments);
      }
      return lr;
    }(),
    U = /*#__PURE__*/function () {
      var _U = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee143(e, t) {
        var n, _t62;
        return _regenerator().w(function (_context144) {
          while (1) switch (_context144.p = _context144.n) {
            case 0:
              _context144.n = 1;
              return e.getItem(t);
            case 1:
              n = _context144.v;
              if (n) {
                _context144.n = 2;
                break;
              }
              return _context144.a(2, null);
            case 2:
              _context144.p = 2;
              return _context144.a(2, JSON.parse(n));
            case 3:
              _context144.p = 3;
              _t62 = _context144.v;
              return _context144.a(2, null);
          }
        }, _callee143, null, [[2, 3]]);
      }));
      function U(_x50, _x51) {
        return _U.apply(this, arguments);
      }
      return U;
    }(),
    W = /*#__PURE__*/function () {
      var _W = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee144(e, t) {
        return _regenerator().w(function (_context145) {
          while (1) switch (_context145.n) {
            case 0:
              _context145.n = 1;
              return e.removeItem(t);
            case 1:
              return _context145.a(2);
          }
        }, _callee144);
      }));
      function W(_x52, _x53) {
        return _W.apply(this, arguments);
      }
      return W;
    }();
  var ur = class e {
    constructor() {
      this.promise = new e.promiseConstructor((e, t) => {
        this.resolve = e, this.reject = t;
      });
    }
  };
  ur.promiseConstructor = Promise;
  function dr(e) {
    var t = e.split(`.`);
    if (t.length !== 3) throw new Kn(`Invalid JWT structure`);
    for (var _e27 = 0; _e27 < t.length; _e27++) if (!An.test(t[_e27])) throw new Kn(`JWT not in base64url format`);
    return {
      header: JSON.parse(Qn(t[0])),
      payload: JSON.parse(Qn(t[1])),
      signature: z(t[2]),
      raw: {
        header: t[0],
        payload: t[1]
      }
    };
  }
  function fr(_x54) {
    return _fr.apply(this, arguments);
  }
  function _fr() {
    _fr = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee311(e) {
      return _regenerator().w(function (_context312) {
        while (1) switch (_context312.n) {
          case 0:
            _context312.n = 1;
            return new Promise(t => {
              setTimeout(() => t(null), e);
            });
          case 1:
            return _context312.a(2, _context312.v);
        }
      }, _callee311);
    }));
    return _fr.apply(this, arguments);
  }
  function pr(e, t) {
    return new Promise((n, r) => {
      _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee145() {
        var i, _r8, _t63;
        return _regenerator().w(function (_context146) {
          while (1) switch (_context146.p = _context146.n) {
            case 0:
              i = 0;
            case 1:
              if (!(i < 1 / 0)) {
                _context146.n = 7;
                break;
              }
              _context146.p = 2;
              _context146.n = 3;
              return e(i);
            case 3:
              _r8 = _context146.v;
              if (t(i, null, _r8)) {
                _context146.n = 4;
                break;
              }
              n(_r8);
              return _context146.a(2);
            case 4:
              _context146.n = 6;
              break;
            case 5:
              _context146.p = 5;
              _t63 = _context146.v;
              if (t(i, _t63)) {
                _context146.n = 6;
                break;
              }
              r(_t63);
              return _context146.a(2);
            case 6:
              i++;
              _context146.n = 1;
              break;
            case 7:
              return _context146.a(2);
          }
        }, _callee145, null, [[2, 5]]);
      }))();
    });
  }
  function mr(e) {
    return (`0` + e.toString(16)).substr(-2);
  }
  function hr() {
    var e = new Uint32Array(56);
    if (typeof crypto > `u`) {
      var _e28 = ``;
      for (var t = 0; t < 56; t++) _e28 += `ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~`.charAt(Math.floor(Math.random() * 66));
      return _e28;
    }
    return crypto.getRandomValues(e), Array.from(e, mr).join(``);
  }
  function gr(_x55) {
    return _gr.apply(this, arguments);
  }
  function _gr() {
    _gr = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee312(e) {
      var t, n, r;
      return _regenerator().w(function (_context313) {
        while (1) switch (_context313.n) {
          case 0:
            t = new TextEncoder().encode(e);
            _context313.n = 1;
            return crypto.subtle.digest(`SHA-256`, t);
          case 1:
            n = _context313.v;
            r = new Uint8Array(n);
            return _context313.a(2, Array.from(r).map(e => String.fromCharCode(e)).join(``));
        }
      }, _callee312);
    }));
    return _gr.apply(this, arguments);
  }
  function _r(_x56) {
    return _r9.apply(this, arguments);
  }
  function _r9() {
    _r9 = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee313(e) {
      var t;
      return _regenerator().w(function (_context314) {
        while (1) switch (_context314.n) {
          case 0:
            if (typeof crypto < `u` && crypto.subtle !== void 0 && typeof TextEncoder < `u`) {
              _context314.n = 1;
              break;
            }
            return _context314.a(2, (console.warn(`WebCrypto API is not supported. Code challenge method will default to use plain instead of sha256.`), e));
          case 1:
            _context314.n = 2;
            return gr(e);
          case 2:
            t = _context314.v;
            return _context314.a(2, btoa(t).replace(/\+/g, `-`).replace(/\//g, `_`).replace(/=+$/, ``));
        }
      }, _callee313);
    }));
    return _r9.apply(this, arguments);
  }
  function G(_x57, _x58) {
    return _G.apply(this, arguments);
  }
  function _G() {
    _G = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee314(e, t, n = !1) {
      var r, i, a;
      return _regenerator().w(function (_context315) {
        while (1) switch (_context315.n) {
          case 0:
            r = hr(), i = r;
            n && (i += `/recovery`);
            _context315.n = 1;
            return lr(e, `${t}-code-verifier`, i);
          case 1:
            _context315.n = 2;
            return _r(r);
          case 2:
            a = _context315.v;
            return _context315.a(2, [a, r === a ? `plain` : `s256`]);
        }
      }, _callee314);
    }));
    return _G.apply(this, arguments);
  }
  var vr = /^2[0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|1[0-9]|2[0-9]|3[0-1])$/i;
  function yr(e) {
    var t = e.headers.get(On);
    if (!t || !t.match(vr)) return null;
    try {
      return new Date(`${t}T00:00:00.0Z`);
    } catch (_unused18) {
      return null;
    }
  }
  function br(e) {
    if (!e) throw Error(`Missing exp claim`);
    if (e <= Math.floor(Date.now() / 1e3)) throw Error(`JWT has expired`);
  }
  function xr(e) {
    switch (e) {
      case `RS256`:
        return {
          name: `RSASSA-PKCS1-v1_5`,
          hash: {
            name: `SHA-256`
          }
        };
      case `ES256`:
        return {
          name: `ECDSA`,
          namedCurve: `P-256`,
          hash: {
            name: `SHA-256`
          }
        };
      default:
        throw Error(`Invalid alg claim`);
    }
  }
  var Sr = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  function K(e) {
    if (!Sr.test(e)) throw Error(`@supabase/auth-js: Expected parameter to be UUID but is not`);
  }
  function q(e) {
    if (!e.passkey) throw Error("@supabase/auth-js: the passkey API is experimental and disabled by default. Enable it by passing `auth: { experimental: { passkey: true } }` to createClient (or to the GoTrueClient constructor).");
  }
  function Cr() {
    return new Proxy({}, {
      get: (e, t) => {
        if (t === `__isUserNotAvailableProxy`) return !0;
        if (typeof t == `symbol`) {
          var _e29 = t.toString();
          if (_e29 === `Symbol(Symbol.toPrimitive)` || _e29 === `Symbol(Symbol.toStringTag)` || _e29 === `Symbol(util.inspect.custom)`) return;
        }
        throw Error(`@supabase/auth-js: client was created with userStorage option and there was no user stored in the user storage. Accessing the "${t}" property of the session object is not supported. Please use getUser() instead.`);
      },
      set: (e, t) => {
        throw Error(`@supabase/auth-js: client was created with userStorage option and there was no user stored in the user storage. Setting the "${t}" property of the session object is not supported. Please use getUser() to fetch a user object you can manipulate.`);
      },
      deleteProperty: (e, t) => {
        throw Error(`@supabase/auth-js: client was created with userStorage option and there was no user stored in the user storage. Deleting the "${t}" property of the session object is not supported. Please use getUser() to fetch a user object you can manipulate.`);
      }
    });
  }
  function wr(e, t) {
    return new Proxy(e, {
      get: (e, n, r) => {
        if (n === `__isInsecureUserWarningProxy`) return !0;
        if (typeof n == `symbol`) {
          var _t64 = n.toString();
          if (_t64 === `Symbol(Symbol.toPrimitive)` || _t64 === `Symbol(Symbol.toStringTag)` || _t64 === `Symbol(util.inspect.custom)` || _t64 === `Symbol(nodejs.util.inspect.custom)`) return Reflect.get(e, n, r);
        }
        return !t.value && typeof n == `string` && (console.warn(`Using the user object as returned from supabase.auth.getSession() or from some supabase.auth.onAuthStateChange() events could be insecure! This value comes directly from the storage medium (usually cookies on the server) and may not be authentic. Use supabase.auth.getUser() instead which authenticates the data by contacting the Supabase Auth server.`), t.value = !0), Reflect.get(e, n, r);
      }
    });
  }
  function Tr(e) {
    return JSON.parse(JSON.stringify(e));
  }
  var J = e => {
      if (typeof e == `object` && e) {
        var t = e;
        if (typeof t.msg == `string`) return t.msg;
        if (typeof t.message == `string`) return t.message;
        if (typeof t.error_description == `string`) return t.error_description;
        if (typeof t.error == `string`) return t.error;
      }
      return JSON.stringify(e);
    },
    Er = [500, 501, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 528, 529, 530];
  function Dr(_x59) {
    return _Dr.apply(this, arguments);
  }
  function _Dr() {
    _Dr = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee315(e) {
      var t, n, r, _t$weak_password, _t265;
      return _regenerator().w(function (_context316) {
        while (1) switch (_context316.p = _context316.n) {
          case 0:
            if (cr(e)) {
              _context316.n = 1;
              break;
            }
            throw new Bn(J(e), 0);
          case 1:
            if (!Er.includes(e.status)) {
              _context316.n = 2;
              break;
            }
            throw new Bn(J(e), e.status);
          case 2:
            _context316.p = 2;
            _context316.n = 3;
            return e.json();
          case 3:
            t = _context316.v;
            _context316.n = 5;
            break;
          case 4:
            _context316.p = 4;
            _t265 = _context316.v;
            throw new F(J(_t265), _t265);
          case 5:
            r = yr(e);
            if (!(r && r.getTime() >= kn[`2024-01-01`].timestamp && typeof t == `object` && t && typeof t.code == `string` ? n = t.code : typeof t == `object` && t && typeof t.error_code == `string` && (n = t.error_code), n)) {
              _context316.n = 8;
              break;
            }
            if (!(n === `weak_password`)) {
              _context316.n = 6;
              break;
            }
            throw new Wn(J(t), e.status, ((_t$weak_password = t.weak_password) === null || _t$weak_password === void 0 ? void 0 : _t$weak_password.reasons) || []);
          case 6:
            if (!(n === `session_not_found`)) {
              _context316.n = 7;
              break;
            }
            throw new L();
          case 7:
            _context316.n = 9;
            break;
          case 8:
            if (!(typeof t == `object` && t && typeof t.weak_password == `object` && t.weak_password && Array.isArray(t.weak_password.reasons) && t.weak_password.reasons.length && t.weak_password.reasons.reduce((e, t) => e && typeof t == `string`, !0))) {
              _context316.n = 9;
              break;
            }
            throw new Wn(J(t), e.status, t.weak_password.reasons);
          case 9:
            throw new jn(J(t), e.status || 500, n);
          case 10:
            return _context316.a(2);
        }
      }, _callee315, null, [[2, 4]]);
    }));
    return _Dr.apply(this, arguments);
  }
  var Or = (e, t, n, r) => {
    var i = {
      method: e,
      headers: (t === null || t === void 0 ? void 0 : t.headers) || {}
    };
    return e === `GET` ? i : (i.headers = Object.assign({
      "Content-Type": `application/json;charset=UTF-8`
    }, t === null || t === void 0 ? void 0 : t.headers), i.body = JSON.stringify(r), Object.assign(Object.assign({}, i), n));
  };
  function Y(_x60, _x61, _x62, _x63) {
    return _Y.apply(this, arguments);
  }
  function _Y() {
    _Y = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee316(e, t, n, r) {
      var _r$query;
      var i, a, o;
      return _regenerator().w(function (_context317) {
        while (1) switch (_context317.n) {
          case 0:
            i = Object.assign({}, r === null || r === void 0 ? void 0 : r.headers);
            i[On] || (i[On] = kn[`2024-01-01`].name), (r === null || r === void 0 ? void 0 : r.jwt) && (i.Authorization = `Bearer ${r.jwt}`);
            a = (_r$query = r === null || r === void 0 ? void 0 : r.query) !== null && _r$query !== void 0 ? _r$query : {};
            (r === null || r === void 0 ? void 0 : r.redirectTo) && (a.redirect_to = r.redirectTo);
            _context317.n = 1;
            return kr(e, t, n + (Object.keys(a).length ? `?` + new URLSearchParams(a).toString() : ``), {
              headers: i,
              noResolveJson: r === null || r === void 0 ? void 0 : r.noResolveJson
            }, {}, r === null || r === void 0 ? void 0 : r.body);
          case 1:
            o = _context317.v;
            return _context317.a(2, r !== null && r !== void 0 && r.xform ? r === null || r === void 0 ? void 0 : r.xform(o) : {
              data: Object.assign({}, o),
              error: null
            });
        }
      }, _callee316);
    }));
    return _Y.apply(this, arguments);
  }
  function kr(_x64, _x65, _x66, _x67, _x68, _x69) {
    return _kr.apply(this, arguments);
  }
  function _kr() {
    _kr = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee317(e, t, n, r, i, a) {
      var o, s, _t266, _t267, _t268;
      return _regenerator().w(function (_context318) {
        while (1) switch (_context318.p = _context318.n) {
          case 0:
            o = Or(t, r, i, a);
            _context318.p = 1;
            _context318.n = 2;
            return e(n, Object.assign({}, o));
          case 2:
            s = _context318.v;
            _context318.n = 4;
            break;
          case 3:
            _context318.p = 3;
            _t266 = _context318.v;
            throw console.error(_t266), new Bn(J(_t266), 0);
          case 4:
            _t267 = s.ok;
            if (_t267) {
              _context318.n = 5;
              break;
            }
            _context318.n = 5;
            return Dr(s);
          case 5:
            if (!(r !== null && r !== void 0 && r.noResolveJson)) {
              _context318.n = 6;
              break;
            }
            return _context318.a(2, s);
          case 6:
            _context318.p = 6;
            _context318.n = 7;
            return s.json();
          case 7:
            return _context318.a(2, _context318.v);
          case 8:
            _context318.p = 8;
            _t268 = _context318.v;
            _context318.n = 9;
            return Dr(_t268);
          case 9:
            return _context318.a(2);
        }
      }, _callee317, null, [[6, 8], [1, 3]]);
    }));
    return _kr.apply(this, arguments);
  }
  function X(e) {
    var _e$user;
    var t = null;
    Pr(e) && (t = Object.assign({}, e), e.expires_at || (t.expires_at = rr(e.expires_in)));
    var n = (_e$user = e.user) !== null && _e$user !== void 0 ? _e$user : typeof (e === null || e === void 0 ? void 0 : e.id) == `string` ? e : null;
    return {
      data: {
        session: t,
        user: n
      },
      error: null
    };
  }
  function Ar(e) {
    var t = X(e);
    return !t.error && e.weak_password && typeof e.weak_password == `object` && Array.isArray(e.weak_password.reasons) && e.weak_password.reasons.length && e.weak_password.message && typeof e.weak_password.message == `string` && e.weak_password.reasons.reduce((e, t) => e && typeof t == `string`, !0) && (t.data.weak_password = e.weak_password), t;
  }
  function Z(e) {
    var _e$user2;
    return {
      data: {
        user: (_e$user2 = e.user) !== null && _e$user2 !== void 0 ? _e$user2 : e
      },
      error: null
    };
  }
  function jr(e) {
    return {
      data: e,
      error: null
    };
  }
  function Mr(e) {
    var n = e.action_link,
      r = e.email_otp,
      i = e.hashed_token,
      a = e.redirect_to,
      o = e.verification_type,
      s = t(e, [`action_link`, `email_otp`, `hashed_token`, `redirect_to`, `verification_type`]);
    return {
      data: {
        properties: {
          action_link: n,
          email_otp: r,
          hashed_token: i,
          redirect_to: a,
          verification_type: o
        },
        user: Object.assign({}, s)
      },
      error: null
    };
  }
  function Nr(e) {
    return e;
  }
  function Pr(e) {
    return !!e.access_token && !!e.refresh_token && !!e.expires_in;
  }
  var Fr = [`global`, `local`, `others`];
  var Ir = class {
    constructor({
      url: e = ``,
      headers: t = {},
      fetch: n,
      experimental: r
    }) {
      this.url = e, this.headers = t, this.fetch = sr(n), this.experimental = r !== null && r !== void 0 ? r : {}, this.mfa = {
        listFactors: this._listFactors.bind(this),
        deleteFactor: this._deleteFactor.bind(this)
      }, this.oauth = {
        listClients: this._listOAuthClients.bind(this),
        createClient: this._createOAuthClient.bind(this),
        getClient: this._getOAuthClient.bind(this),
        updateClient: this._updateOAuthClient.bind(this),
        deleteClient: this._deleteOAuthClient.bind(this),
        regenerateClientSecret: this._regenerateOAuthClientSecret.bind(this)
      }, this.customProviders = {
        listProviders: this._listCustomProviders.bind(this),
        createProvider: this._createCustomProvider.bind(this),
        getProvider: this._getCustomProvider.bind(this),
        updateProvider: this._updateCustomProvider.bind(this),
        deleteProvider: this._deleteCustomProvider.bind(this)
      }, this.passkey = {
        listPasskeys: this._adminListPasskeys.bind(this),
        deletePasskey: this._adminDeletePasskey.bind(this)
      };
    }
    signOut(_x70) {
      var _this93 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee146(e, t = Fr[0]) {
        var _t65;
        return _regenerator().w(function (_context147) {
          while (1) switch (_context147.p = _context147.n) {
            case 0:
              if (!(Fr.indexOf(t) < 0)) {
                _context147.n = 1;
                break;
              }
              throw Error(`@supabase/auth-js: Parameter scope must be one of ${Fr.join(`, `)}`);
            case 1:
              _context147.p = 1;
              _context147.n = 2;
              return Y(_this93.fetch, `POST`, `${_this93.url}/logout?scope=${t}`, {
                headers: _this93.headers,
                jwt: e,
                noResolveJson: !0
              });
            case 2:
              return _context147.a(2, {
                data: null,
                error: null
              });
            case 3:
              _context147.p = 3;
              _t65 = _context147.v;
              if (!P(_t65)) {
                _context147.n = 4;
                break;
              }
              return _context147.a(2, {
                data: null,
                error: _t65
              });
            case 4:
              throw _t65;
            case 5:
              return _context147.a(2);
          }
        }, _callee146, null, [[1, 3]]);
      })).apply(this, arguments);
    }
    inviteUserByEmail(_x71) {
      var _this94 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee147(e, t = {}) {
        var _t66;
        return _regenerator().w(function (_context148) {
          while (1) switch (_context148.p = _context148.n) {
            case 0:
              _context148.p = 0;
              _context148.n = 1;
              return Y(_this94.fetch, `POST`, `${_this94.url}/invite`, {
                body: {
                  email: e,
                  data: t.data
                },
                headers: _this94.headers,
                redirectTo: t.redirectTo,
                xform: Z
              });
            case 1:
              return _context148.a(2, _context148.v);
            case 2:
              _context148.p = 2;
              _t66 = _context148.v;
              if (!P(_t66)) {
                _context148.n = 3;
                break;
              }
              return _context148.a(2, {
                data: {
                  user: null
                },
                error: _t66
              });
            case 3:
              throw _t66;
            case 4:
              return _context148.a(2);
          }
        }, _callee147, null, [[0, 2]]);
      })).apply(this, arguments);
    }
    generateLink(e) {
      var _this95 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee148() {
        var n, r, i, _t67;
        return _regenerator().w(function (_context149) {
          while (1) switch (_context149.p = _context149.n) {
            case 0:
              _context149.p = 0;
              n = e.options, r = t(e, [`options`]), i = Object.assign(Object.assign({}, r), n);
              `newEmail` in r && (i.new_email = r === null || r === void 0 ? void 0 : r.newEmail, delete i.newEmail);
              _context149.n = 1;
              return Y(_this95.fetch, `POST`, `${_this95.url}/admin/generate_link`, {
                body: i,
                headers: _this95.headers,
                xform: Mr,
                redirectTo: n === null || n === void 0 ? void 0 : n.redirectTo
              });
            case 1:
              return _context149.a(2, _context149.v);
            case 2:
              _context149.p = 2;
              _t67 = _context149.v;
              if (!P(_t67)) {
                _context149.n = 3;
                break;
              }
              return _context149.a(2, {
                data: {
                  properties: null,
                  user: null
                },
                error: _t67
              });
            case 3:
              throw _t67;
            case 4:
              return _context149.a(2);
          }
        }, _callee148, null, [[0, 2]]);
      }))();
    }
    createUser(e) {
      var _this96 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee149() {
        var _t68;
        return _regenerator().w(function (_context150) {
          while (1) switch (_context150.p = _context150.n) {
            case 0:
              _context150.p = 0;
              _context150.n = 1;
              return Y(_this96.fetch, `POST`, `${_this96.url}/admin/users`, {
                body: e,
                headers: _this96.headers,
                xform: Z
              });
            case 1:
              return _context150.a(2, _context150.v);
            case 2:
              _context150.p = 2;
              _t68 = _context150.v;
              if (!P(_t68)) {
                _context150.n = 3;
                break;
              }
              return _context150.a(2, {
                data: {
                  user: null
                },
                error: _t68
              });
            case 3:
              throw _t68;
            case 4:
              return _context150.a(2);
          }
        }, _callee149, null, [[0, 2]]);
      }))();
    }
    listUsers(e) {
      var _this97 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee150() {
        var _e$page$toString, _e$page, _e$perPage$toString, _e$perPage, _n$headers$get, _n$headers$get$split, _n$headers$get2, _t69, n, r, i, a, _t70;
        return _regenerator().w(function (_context151) {
          while (1) switch (_context151.p = _context151.n) {
            case 0:
              _context151.p = 0;
              _t69 = {
                nextPage: null,
                lastPage: 0,
                total: 0
              };
              _context151.n = 1;
              return Y(_this97.fetch, `GET`, `${_this97.url}/admin/users`, {
                headers: _this97.headers,
                noResolveJson: !0,
                query: {
                  page: (_e$page$toString = e === null || e === void 0 || (_e$page = e.page) === null || _e$page === void 0 ? void 0 : _e$page.toString()) !== null && _e$page$toString !== void 0 ? _e$page$toString : ``,
                  per_page: (_e$perPage$toString = e === null || e === void 0 || (_e$perPage = e.perPage) === null || _e$perPage === void 0 ? void 0 : _e$perPage.toString()) !== null && _e$perPage$toString !== void 0 ? _e$perPage$toString : ``
                },
                xform: Nr
              });
            case 1:
              n = _context151.v;
              if (!n.error) {
                _context151.n = 2;
                break;
              }
              throw n.error;
            case 2:
              _context151.n = 3;
              return n.json();
            case 3:
              r = _context151.v;
              i = (_n$headers$get = n.headers.get(`x-total-count`)) !== null && _n$headers$get !== void 0 ? _n$headers$get : 0;
              a = (_n$headers$get$split = (_n$headers$get2 = n.headers.get(`link`)) === null || _n$headers$get2 === void 0 ? void 0 : _n$headers$get2.split(`,`)) !== null && _n$headers$get$split !== void 0 ? _n$headers$get$split : [];
              return _context151.a(2, (a.length > 0 && (a.forEach(e => {
                var n = parseInt(e.split(`;`)[0].split(`=`)[1].substring(0, 1)),
                  r = JSON.parse(e.split(`;`)[1].split(`=`)[1]);
                _t69[`${r}Page`] = n;
              }), _t69.total = parseInt(i)), {
                data: Object.assign(Object.assign({}, r), _t69),
                error: null
              }));
            case 4:
              _context151.p = 4;
              _t70 = _context151.v;
              if (!P(_t70)) {
                _context151.n = 5;
                break;
              }
              return _context151.a(2, {
                data: {
                  users: []
                },
                error: _t70
              });
            case 5:
              throw _t70;
            case 6:
              return _context151.a(2);
          }
        }, _callee150, null, [[0, 4]]);
      }))();
    }
    getUserById(e) {
      var _this98 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee151() {
        var _t71;
        return _regenerator().w(function (_context152) {
          while (1) switch (_context152.p = _context152.n) {
            case 0:
              K(e);
              _context152.p = 1;
              _context152.n = 2;
              return Y(_this98.fetch, `GET`, `${_this98.url}/admin/users/${e}`, {
                headers: _this98.headers,
                xform: Z
              });
            case 2:
              return _context152.a(2, _context152.v);
            case 3:
              _context152.p = 3;
              _t71 = _context152.v;
              if (!P(_t71)) {
                _context152.n = 4;
                break;
              }
              return _context152.a(2, {
                data: {
                  user: null
                },
                error: _t71
              });
            case 4:
              throw _t71;
            case 5:
              return _context152.a(2);
          }
        }, _callee151, null, [[1, 3]]);
      }))();
    }
    updateUserById(e, t) {
      var _this99 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee152() {
        var _t72;
        return _regenerator().w(function (_context153) {
          while (1) switch (_context153.p = _context153.n) {
            case 0:
              K(e);
              _context153.p = 1;
              _context153.n = 2;
              return Y(_this99.fetch, `PUT`, `${_this99.url}/admin/users/${e}`, {
                body: t,
                headers: _this99.headers,
                xform: Z
              });
            case 2:
              return _context153.a(2, _context153.v);
            case 3:
              _context153.p = 3;
              _t72 = _context153.v;
              if (!P(_t72)) {
                _context153.n = 4;
                break;
              }
              return _context153.a(2, {
                data: {
                  user: null
                },
                error: _t72
              });
            case 4:
              throw _t72;
            case 5:
              return _context153.a(2);
          }
        }, _callee152, null, [[1, 3]]);
      }))();
    }
    deleteUser(_x72) {
      var _this100 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee153(e, t = !1) {
        var _t73;
        return _regenerator().w(function (_context154) {
          while (1) switch (_context154.p = _context154.n) {
            case 0:
              K(e);
              _context154.p = 1;
              _context154.n = 2;
              return Y(_this100.fetch, `DELETE`, `${_this100.url}/admin/users/${e}`, {
                headers: _this100.headers,
                body: {
                  should_soft_delete: t
                },
                xform: Z
              });
            case 2:
              return _context154.a(2, _context154.v);
            case 3:
              _context154.p = 3;
              _t73 = _context154.v;
              if (!P(_t73)) {
                _context154.n = 4;
                break;
              }
              return _context154.a(2, {
                data: {
                  user: null
                },
                error: _t73
              });
            case 4:
              throw _t73;
            case 5:
              return _context154.a(2);
          }
        }, _callee153, null, [[1, 3]]);
      })).apply(this, arguments);
    }
    _listFactors(e) {
      var _this101 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee154() {
        var _yield$Y, _t74, n, _t75;
        return _regenerator().w(function (_context155) {
          while (1) switch (_context155.p = _context155.n) {
            case 0:
              K(e.userId);
              _context155.p = 1;
              _context155.n = 2;
              return Y(_this101.fetch, `GET`, `${_this101.url}/admin/users/${e.userId}/factors`, {
                headers: _this101.headers,
                xform: e => ({
                  data: {
                    factors: e
                  },
                  error: null
                })
              });
            case 2:
              _yield$Y = _context155.v;
              _t74 = _yield$Y.data;
              n = _yield$Y.error;
              return _context155.a(2, {
                data: _t74,
                error: n
              });
            case 3:
              _context155.p = 3;
              _t75 = _context155.v;
              if (!P(_t75)) {
                _context155.n = 4;
                break;
              }
              return _context155.a(2, {
                data: null,
                error: _t75
              });
            case 4:
              throw _t75;
            case 5:
              return _context155.a(2);
          }
        }, _callee154, null, [[1, 3]]);
      }))();
    }
    _deleteFactor(e) {
      var _this102 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee155() {
        var _t76, _t77;
        return _regenerator().w(function (_context156) {
          while (1) switch (_context156.p = _context156.n) {
            case 0:
              K(e.userId), K(e.id);
              _context156.p = 1;
              _context156.n = 2;
              return Y(_this102.fetch, `DELETE`, `${_this102.url}/admin/users/${e.userId}/factors/${e.id}`, {
                headers: _this102.headers
              });
            case 2:
              _t76 = _context156.v;
              return _context156.a(2, {
                data: _t76,
                error: null
              });
            case 3:
              _context156.p = 3;
              _t77 = _context156.v;
              if (!P(_t77)) {
                _context156.n = 4;
                break;
              }
              return _context156.a(2, {
                data: null,
                error: _t77
              });
            case 4:
              throw _t77;
            case 5:
              return _context156.a(2);
          }
        }, _callee155, null, [[1, 3]]);
      }))();
    }
    _listOAuthClients(e) {
      var _this103 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee156() {
        var _e$page$toString2, _e$page2, _e$perPage$toString2, _e$perPage2, _n$headers$get3, _n$headers$get$split2, _n$headers$get4, _t78, n, r, i, a, _t79;
        return _regenerator().w(function (_context157) {
          while (1) switch (_context157.p = _context157.n) {
            case 0:
              _context157.p = 0;
              _t78 = {
                nextPage: null,
                lastPage: 0,
                total: 0
              };
              _context157.n = 1;
              return Y(_this103.fetch, `GET`, `${_this103.url}/admin/oauth/clients`, {
                headers: _this103.headers,
                noResolveJson: !0,
                query: {
                  page: (_e$page$toString2 = e === null || e === void 0 || (_e$page2 = e.page) === null || _e$page2 === void 0 ? void 0 : _e$page2.toString()) !== null && _e$page$toString2 !== void 0 ? _e$page$toString2 : ``,
                  per_page: (_e$perPage$toString2 = e === null || e === void 0 || (_e$perPage2 = e.perPage) === null || _e$perPage2 === void 0 ? void 0 : _e$perPage2.toString()) !== null && _e$perPage$toString2 !== void 0 ? _e$perPage$toString2 : ``
                },
                xform: Nr
              });
            case 1:
              n = _context157.v;
              if (!n.error) {
                _context157.n = 2;
                break;
              }
              throw n.error;
            case 2:
              _context157.n = 3;
              return n.json();
            case 3:
              r = _context157.v;
              i = (_n$headers$get3 = n.headers.get(`x-total-count`)) !== null && _n$headers$get3 !== void 0 ? _n$headers$get3 : 0;
              a = (_n$headers$get$split2 = (_n$headers$get4 = n.headers.get(`link`)) === null || _n$headers$get4 === void 0 ? void 0 : _n$headers$get4.split(`,`)) !== null && _n$headers$get$split2 !== void 0 ? _n$headers$get$split2 : [];
              return _context157.a(2, (a.length > 0 && (a.forEach(e => {
                var n = parseInt(e.split(`;`)[0].split(`=`)[1].substring(0, 1)),
                  r = JSON.parse(e.split(`;`)[1].split(`=`)[1]);
                _t78[`${r}Page`] = n;
              }), _t78.total = parseInt(i)), {
                data: Object.assign(Object.assign({}, r), _t78),
                error: null
              }));
            case 4:
              _context157.p = 4;
              _t79 = _context157.v;
              if (!P(_t79)) {
                _context157.n = 5;
                break;
              }
              return _context157.a(2, {
                data: {
                  clients: []
                },
                error: _t79
              });
            case 5:
              throw _t79;
            case 6:
              return _context157.a(2);
          }
        }, _callee156, null, [[0, 4]]);
      }))();
    }
    _createOAuthClient(e) {
      var _this104 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee157() {
        var _t80;
        return _regenerator().w(function (_context158) {
          while (1) switch (_context158.p = _context158.n) {
            case 0:
              _context158.p = 0;
              _context158.n = 1;
              return Y(_this104.fetch, `POST`, `${_this104.url}/admin/oauth/clients`, {
                body: e,
                headers: _this104.headers,
                xform: e => ({
                  data: e,
                  error: null
                })
              });
            case 1:
              return _context158.a(2, _context158.v);
            case 2:
              _context158.p = 2;
              _t80 = _context158.v;
              if (!P(_t80)) {
                _context158.n = 3;
                break;
              }
              return _context158.a(2, {
                data: null,
                error: _t80
              });
            case 3:
              throw _t80;
            case 4:
              return _context158.a(2);
          }
        }, _callee157, null, [[0, 2]]);
      }))();
    }
    _getOAuthClient(e) {
      var _this105 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee158() {
        var _t81;
        return _regenerator().w(function (_context159) {
          while (1) switch (_context159.p = _context159.n) {
            case 0:
              _context159.p = 0;
              _context159.n = 1;
              return Y(_this105.fetch, `GET`, `${_this105.url}/admin/oauth/clients/${e}`, {
                headers: _this105.headers,
                xform: e => ({
                  data: e,
                  error: null
                })
              });
            case 1:
              return _context159.a(2, _context159.v);
            case 2:
              _context159.p = 2;
              _t81 = _context159.v;
              if (!P(_t81)) {
                _context159.n = 3;
                break;
              }
              return _context159.a(2, {
                data: null,
                error: _t81
              });
            case 3:
              throw _t81;
            case 4:
              return _context159.a(2);
          }
        }, _callee158, null, [[0, 2]]);
      }))();
    }
    _updateOAuthClient(e, t) {
      var _this106 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee159() {
        var _t82;
        return _regenerator().w(function (_context160) {
          while (1) switch (_context160.p = _context160.n) {
            case 0:
              _context160.p = 0;
              _context160.n = 1;
              return Y(_this106.fetch, `PUT`, `${_this106.url}/admin/oauth/clients/${e}`, {
                body: t,
                headers: _this106.headers,
                xform: e => ({
                  data: e,
                  error: null
                })
              });
            case 1:
              return _context160.a(2, _context160.v);
            case 2:
              _context160.p = 2;
              _t82 = _context160.v;
              if (!P(_t82)) {
                _context160.n = 3;
                break;
              }
              return _context160.a(2, {
                data: null,
                error: _t82
              });
            case 3:
              throw _t82;
            case 4:
              return _context160.a(2);
          }
        }, _callee159, null, [[0, 2]]);
      }))();
    }
    _deleteOAuthClient(e) {
      var _this107 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee160() {
        var _t83;
        return _regenerator().w(function (_context161) {
          while (1) switch (_context161.p = _context161.n) {
            case 0:
              _context161.p = 0;
              _context161.n = 1;
              return Y(_this107.fetch, `DELETE`, `${_this107.url}/admin/oauth/clients/${e}`, {
                headers: _this107.headers,
                noResolveJson: !0
              });
            case 1:
              return _context161.a(2, {
                data: null,
                error: null
              });
            case 2:
              _context161.p = 2;
              _t83 = _context161.v;
              if (!P(_t83)) {
                _context161.n = 3;
                break;
              }
              return _context161.a(2, {
                data: null,
                error: _t83
              });
            case 3:
              throw _t83;
            case 4:
              return _context161.a(2);
          }
        }, _callee160, null, [[0, 2]]);
      }))();
    }
    _regenerateOAuthClientSecret(e) {
      var _this108 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee161() {
        var _t84;
        return _regenerator().w(function (_context162) {
          while (1) switch (_context162.p = _context162.n) {
            case 0:
              _context162.p = 0;
              _context162.n = 1;
              return Y(_this108.fetch, `POST`, `${_this108.url}/admin/oauth/clients/${e}/regenerate_secret`, {
                headers: _this108.headers,
                xform: e => ({
                  data: e,
                  error: null
                })
              });
            case 1:
              return _context162.a(2, _context162.v);
            case 2:
              _context162.p = 2;
              _t84 = _context162.v;
              if (!P(_t84)) {
                _context162.n = 3;
                break;
              }
              return _context162.a(2, {
                data: null,
                error: _t84
              });
            case 3:
              throw _t84;
            case 4:
              return _context162.a(2);
          }
        }, _callee161, null, [[0, 2]]);
      }))();
    }
    _listCustomProviders(e) {
      var _this109 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee162() {
        var _t85, _t86;
        return _regenerator().w(function (_context163) {
          while (1) switch (_context163.p = _context163.n) {
            case 0:
              _context163.p = 0;
              _t85 = {};
              e !== null && e !== void 0 && e.type && (_t85.type = e.type);
              _context163.n = 1;
              return Y(_this109.fetch, `GET`, `${_this109.url}/admin/custom-providers`, {
                headers: _this109.headers,
                query: _t85,
                xform: e => {
                  var _e$providers;
                  return {
                    data: {
                      providers: (_e$providers = e === null || e === void 0 ? void 0 : e.providers) !== null && _e$providers !== void 0 ? _e$providers : []
                    },
                    error: null
                  };
                }
              });
            case 1:
              return _context163.a(2, _context163.v);
            case 2:
              _context163.p = 2;
              _t86 = _context163.v;
              if (!P(_t86)) {
                _context163.n = 3;
                break;
              }
              return _context163.a(2, {
                data: {
                  providers: []
                },
                error: _t86
              });
            case 3:
              throw _t86;
            case 4:
              return _context163.a(2);
          }
        }, _callee162, null, [[0, 2]]);
      }))();
    }
    _createCustomProvider(e) {
      var _this110 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee163() {
        var _t87;
        return _regenerator().w(function (_context164) {
          while (1) switch (_context164.p = _context164.n) {
            case 0:
              _context164.p = 0;
              _context164.n = 1;
              return Y(_this110.fetch, `POST`, `${_this110.url}/admin/custom-providers`, {
                body: e,
                headers: _this110.headers,
                xform: e => ({
                  data: e,
                  error: null
                })
              });
            case 1:
              return _context164.a(2, _context164.v);
            case 2:
              _context164.p = 2;
              _t87 = _context164.v;
              if (!P(_t87)) {
                _context164.n = 3;
                break;
              }
              return _context164.a(2, {
                data: null,
                error: _t87
              });
            case 3:
              throw _t87;
            case 4:
              return _context164.a(2);
          }
        }, _callee163, null, [[0, 2]]);
      }))();
    }
    _getCustomProvider(e) {
      var _this111 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee164() {
        var _t88;
        return _regenerator().w(function (_context165) {
          while (1) switch (_context165.p = _context165.n) {
            case 0:
              _context165.p = 0;
              _context165.n = 1;
              return Y(_this111.fetch, `GET`, `${_this111.url}/admin/custom-providers/${e}`, {
                headers: _this111.headers,
                xform: e => ({
                  data: e,
                  error: null
                })
              });
            case 1:
              return _context165.a(2, _context165.v);
            case 2:
              _context165.p = 2;
              _t88 = _context165.v;
              if (!P(_t88)) {
                _context165.n = 3;
                break;
              }
              return _context165.a(2, {
                data: null,
                error: _t88
              });
            case 3:
              throw _t88;
            case 4:
              return _context165.a(2);
          }
        }, _callee164, null, [[0, 2]]);
      }))();
    }
    _updateCustomProvider(e, t) {
      var _this112 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee165() {
        var _t89;
        return _regenerator().w(function (_context166) {
          while (1) switch (_context166.p = _context166.n) {
            case 0:
              _context166.p = 0;
              _context166.n = 1;
              return Y(_this112.fetch, `PUT`, `${_this112.url}/admin/custom-providers/${e}`, {
                body: t,
                headers: _this112.headers,
                xform: e => ({
                  data: e,
                  error: null
                })
              });
            case 1:
              return _context166.a(2, _context166.v);
            case 2:
              _context166.p = 2;
              _t89 = _context166.v;
              if (!P(_t89)) {
                _context166.n = 3;
                break;
              }
              return _context166.a(2, {
                data: null,
                error: _t89
              });
            case 3:
              throw _t89;
            case 4:
              return _context166.a(2);
          }
        }, _callee165, null, [[0, 2]]);
      }))();
    }
    _deleteCustomProvider(e) {
      var _this113 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee166() {
        var _t90;
        return _regenerator().w(function (_context167) {
          while (1) switch (_context167.p = _context167.n) {
            case 0:
              _context167.p = 0;
              _context167.n = 1;
              return Y(_this113.fetch, `DELETE`, `${_this113.url}/admin/custom-providers/${e}`, {
                headers: _this113.headers,
                noResolveJson: !0
              });
            case 1:
              return _context167.a(2, {
                data: null,
                error: null
              });
            case 2:
              _context167.p = 2;
              _t90 = _context167.v;
              if (!P(_t90)) {
                _context167.n = 3;
                break;
              }
              return _context167.a(2, {
                data: null,
                error: _t90
              });
            case 3:
              throw _t90;
            case 4:
              return _context167.a(2);
          }
        }, _callee166, null, [[0, 2]]);
      }))();
    }
    _adminListPasskeys(e) {
      var _this114 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee167() {
        var _t91;
        return _regenerator().w(function (_context168) {
          while (1) switch (_context168.p = _context168.n) {
            case 0:
              q(_this114.experimental), K(e.userId);
              _context168.p = 1;
              _context168.n = 2;
              return Y(_this114.fetch, `GET`, `${_this114.url}/admin/users/${e.userId}/passkeys`, {
                headers: _this114.headers,
                xform: e => ({
                  data: e,
                  error: null
                })
              });
            case 2:
              return _context168.a(2, _context168.v);
            case 3:
              _context168.p = 3;
              _t91 = _context168.v;
              if (!P(_t91)) {
                _context168.n = 4;
                break;
              }
              return _context168.a(2, {
                data: null,
                error: _t91
              });
            case 4:
              throw _t91;
            case 5:
              return _context168.a(2);
          }
        }, _callee167, null, [[1, 3]]);
      }))();
    }
    _adminDeletePasskey(e) {
      var _this115 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee168() {
        var _t92;
        return _regenerator().w(function (_context169) {
          while (1) switch (_context169.p = _context169.n) {
            case 0:
              q(_this115.experimental), K(e.userId), K(e.passkeyId);
              _context169.p = 1;
              _context169.n = 2;
              return Y(_this115.fetch, `DELETE`, `${_this115.url}/admin/users/${e.userId}/passkeys/${e.passkeyId}`, {
                headers: _this115.headers,
                noResolveJson: !0
              });
            case 2:
              return _context169.a(2, {
                data: null,
                error: null
              });
            case 3:
              _context169.p = 3;
              _t92 = _context169.v;
              if (!P(_t92)) {
                _context169.n = 4;
                break;
              }
              return _context169.a(2, {
                data: null,
                error: _t92
              });
            case 4:
              throw _t92;
            case 5:
              return _context169.a(2);
          }
        }, _callee168, null, [[1, 3]]);
      }))();
    }
  };
  function Lr(e = {}) {
    return {
      getItem: t => e[t] || null,
      setItem: (t, n) => {
        e[t] = n;
      },
      removeItem: t => {
        delete e[t];
      }
    };
  }
  var Q = {
    debug: !!(globalThis && ar() && globalThis.localStorage && globalThis.localStorage.getItem(`supabase.gotrue-js.locks.debug`) === `true`)
  };
  var Rr = class extends Error {
      constructor(e) {
        super(e), this.isAcquireTimeout = !0;
      }
    },
    zr = class extends Rr {},
    Br = class extends Rr {};
  function Vr(_x73, _x74, _x75) {
    return _Vr.apply(this, arguments);
  }
  function _Vr() {
    _Vr = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee320(e, t, n) {
      var r, i, _t270;
      return _regenerator().w(function (_context321) {
        while (1) switch (_context321.p = _context321.n) {
          case 0:
            Q.debug && console.log(`@supabase/gotrue-js: navigatorLock: acquire lock`, e, t);
            r = new globalThis.AbortController();
            t > 0 && (i = setTimeout(() => {
              r.abort(), Q.debug && console.log(`@supabase/gotrue-js: navigatorLock acquire timed out`, e);
            }, t));
            _context321.n = 1;
            return Promise.resolve();
          case 1:
            _context321.p = 1;
            _context321.n = 2;
            return globalThis.navigator.locks.request(e, t === 0 ? {
              mode: `exclusive`,
              ifAvailable: !0
            } : {
              mode: `exclusive`,
              signal: r.signal
            }, /*#__PURE__*/function () {
              var _ref96 = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee318(r) {
                var _e70, _t269;
                return _regenerator().w(function (_context319) {
                  while (1) switch (_context319.p = _context319.n) {
                    case 0:
                      if (!r) {
                        _context319.n = 5;
                        break;
                      }
                      clearTimeout(i), Q.debug && console.log(`@supabase/gotrue-js: navigatorLock: acquired`, e, r.name);
                      _context319.p = 1;
                      _context319.n = 2;
                      return n();
                    case 2:
                      return _context319.a(2, _context319.v);
                    case 3:
                      _context319.p = 3;
                      Q.debug && console.log(`@supabase/gotrue-js: navigatorLock: released`, e, r.name);
                      return _context319.f(3);
                    case 4:
                      _context319.n = 12;
                      break;
                    case 5:
                      if (!(t === 0)) {
                        _context319.n = 6;
                        break;
                      }
                      throw Q.debug && console.log(`@supabase/gotrue-js: navigatorLock: not immediately available`, e), new zr(`Acquiring an exclusive Navigator LockManager lock "${e}" immediately failed`);
                    case 6:
                      if (!Q.debug) {
                        _context319.n = 10;
                        break;
                      }
                      _context319.p = 7;
                      _context319.n = 8;
                      return globalThis.navigator.locks.query();
                    case 8:
                      _e70 = _context319.v;
                      console.log(`@supabase/gotrue-js: Navigator LockManager state`, JSON.stringify(_e70, null, `  `));
                      _context319.n = 10;
                      break;
                    case 9:
                      _context319.p = 9;
                      _t269 = _context319.v;
                      console.warn(`@supabase/gotrue-js: Error when querying Navigator LockManager state`, _t269);
                    case 10:
                      console.warn(`@supabase/gotrue-js: Navigator LockManager returned a null lock when using #request without ifAvailable set to true, it appears this browser is not following the LockManager spec https://developer.mozilla.org/en-US/docs/Web/API/LockManager/request`);
                      clearTimeout(i);
                      _context319.n = 11;
                      return n();
                    case 11:
                      return _context319.a(2, _context319.v);
                    case 12:
                      return _context319.a(2);
                  }
                }, _callee318, null, [[7, 9], [1,, 3, 4]]);
              }));
              return function (_x125) {
                return _ref96.apply(this, arguments);
              };
            }());
          case 2:
            return _context321.a(2, _context321.v);
          case 3:
            _context321.p = 3;
            _t270 = _context321.v;
            if (!(t > 0 && clearTimeout(i), typeof _t270 == `object` && _t270 && `name` in _t270 && _t270.name === `AbortError` && t > 0)) {
              _context321.n = 6;
              break;
            }
            if (!r.signal.aborted) {
              _context321.n = 5;
              break;
            }
            Q.debug && console.log(`@supabase/gotrue-js: navigatorLock: acquire timeout, recovering by stealing lock`, e);
            console.warn(`@supabase/gotrue-js: Lock "${e}" was not released within ${t}ms. This may indicate an orphaned lock from a component unmount (e.g., React Strict Mode). Forcefully acquiring the lock to recover.`);
            _context321.n = 4;
            return Promise.resolve().then(() => globalThis.navigator.locks.request(e, {
              mode: `exclusive`,
              steal: !0
            }, /*#__PURE__*/function () {
              var _ref97 = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee319(t) {
                return _regenerator().w(function (_context320) {
                  while (1) switch (_context320.p = _context320.n) {
                    case 0:
                      if (!t) {
                        _context320.n = 5;
                        break;
                      }
                      Q.debug && console.log(`@supabase/gotrue-js: navigatorLock: recovered (stolen)`, e, t.name);
                      _context320.p = 1;
                      _context320.n = 2;
                      return n();
                    case 2:
                      return _context320.a(2, _context320.v);
                    case 3:
                      _context320.p = 3;
                      Q.debug && console.log(`@supabase/gotrue-js: navigatorLock: released (stolen)`, e, t.name);
                      return _context320.f(3);
                    case 4:
                      _context320.n = 7;
                      break;
                    case 5:
                      console.warn(`@supabase/gotrue-js: Navigator LockManager returned null lock even with steal: true`);
                      _context320.n = 6;
                      return n();
                    case 6:
                      return _context320.a(2, _context320.v);
                    case 7:
                      return _context320.a(2);
                  }
                }, _callee319, null, [[1,, 3, 4]]);
              }));
              return function (_x126) {
                return _ref97.apply(this, arguments);
              };
            }()));
          case 4:
            return _context321.a(2, _context321.v);
          case 5:
            throw Q.debug && console.log(`@supabase/gotrue-js: navigatorLock: lock was stolen by another request`, e), new zr(`Lock "${e}" was released because another request stole it`);
          case 6:
            throw _t270;
          case 7:
            return _context321.a(2);
        }
      }, _callee320, null, [[1, 3]]);
    }));
    return _Vr.apply(this, arguments);
  }
  var Hr = {};
  function Ur(_x76, _x77, _x78) {
    return _Ur.apply(this, arguments);
  }
  function _Ur() {
    _Ur = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee324(e, t, n) {
      var _Hr$e;
      var r, i, a;
      return _regenerator().w(function (_context325) {
        while (1) switch (_context325.n) {
          case 0:
            r = (_Hr$e = Hr[e]) !== null && _Hr$e !== void 0 ? _Hr$e : Promise.resolve(), i = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee321() {
              var _t271;
              return _regenerator().w(function (_context322) {
                while (1) switch (_context322.p = _context322.n) {
                  case 0:
                    _context322.p = 0;
                    _context322.n = 1;
                    return r;
                  case 1:
                    return _context322.a(2, null);
                  case 2:
                    _context322.p = 2;
                    _t271 = _context322.v;
                    return _context322.a(2, null);
                }
              }, _callee321, null, [[0, 2]]);
            }))(), a = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee322() {
              var r, _n30, _t272;
              return _regenerator().w(function (_context323) {
                while (1) switch (_context323.p = _context323.n) {
                  case 0:
                    r = null;
                    _context323.p = 1;
                    _n30 = t >= 0 ? new Promise((n, i) => {
                      r = setTimeout(() => {
                        console.warn(`@supabase/gotrue-js: Lock "${e}" acquisition timed out after ${t}ms. This may be caused by another operation holding the lock. Consider increasing lockAcquireTimeout or checking for stuck operations.`), i(new Br(`Acquiring process lock with name "${e}" timed out`));
                      }, t);
                    }) : null;
                    _context323.n = 2;
                    return Promise.race([i, _n30].filter(e => e));
                  case 2:
                    r !== null && clearTimeout(r);
                    _context323.n = 4;
                    break;
                  case 3:
                    _context323.p = 3;
                    _t272 = _context323.v;
                    if (!(r !== null && clearTimeout(r), _t272 instanceof Rr)) {
                      _context323.n = 4;
                      break;
                    }
                    throw _t272;
                  case 4:
                    _context323.n = 5;
                    return n();
                  case 5:
                    return _context323.a(2, _context323.v);
                }
              }, _callee322, null, [[1, 3]]);
            }))();
            Hr[e] = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee323() {
              var _t273, _t274;
              return _regenerator().w(function (_context324) {
                while (1) switch (_context324.p = _context324.n) {
                  case 0:
                    _context324.p = 0;
                    _context324.n = 1;
                    return a;
                  case 1:
                    return _context324.a(2, _context324.v);
                  case 2:
                    _context324.p = 2;
                    _t273 = _context324.v;
                    if (!(_t273 instanceof Rr)) {
                      _context324.n = 7;
                      break;
                    }
                    _context324.p = 3;
                    _context324.n = 4;
                    return r;
                  case 4:
                    _context324.n = 6;
                    break;
                  case 5:
                    _context324.p = 5;
                    _t274 = _context324.v;
                  case 6:
                    return _context324.a(2, null);
                  case 7:
                    throw _t273;
                  case 8:
                    return _context324.a(2);
                }
              }, _callee323, null, [[3, 5], [0, 2]]);
            }))();
            _context325.n = 1;
            return a;
          case 1:
            return _context325.a(2, _context325.v);
        }
      }, _callee324);
    }));
    return _Ur.apply(this, arguments);
  }
  function Wr() {
    if (typeof globalThis != `object`) try {
      Object.defineProperty(Object.prototype, `__magic__`, {
        get: function get() {
          return this;
        },
        configurable: !0
      }), __magic__.globalThis = __magic__, delete Object.prototype.__magic__;
    } catch (_unused19) {
      typeof self < `u` && (self.globalThis = self);
    }
  }
  function Gr(e) {
    if (!/^0x[a-fA-F0-9]{40}$/.test(e)) throw Error(`@supabase/auth-js: Address "${e}" is invalid.`);
    return e.toLowerCase();
  }
  function Kr(e) {
    return parseInt(e, 16);
  }
  function qr(e) {
    var t = new TextEncoder().encode(e);
    return `0x` + Array.from(t, e => e.toString(16).padStart(2, `0`)).join(``);
  }
  function Jr(e) {
    var _e$statement;
    var t = e.chainId,
      n = e.domain,
      r = e.expirationTime,
      _e$issuedAt = e.issuedAt,
      i = _e$issuedAt === void 0 ? new Date() : _e$issuedAt,
      a = e.nonce,
      o = e.notBefore,
      s = e.requestId,
      c = e.resources,
      l = e.scheme,
      u = e.uri,
      d = e.version;
    if (!Number.isInteger(t)) throw Error(`@supabase/auth-js: Invalid SIWE message field "chainId". Chain ID must be a EIP-155 chain ID. Provided value: ${t}`);
    if (!n) throw Error(`@supabase/auth-js: Invalid SIWE message field "domain". Domain must be provided.`);
    if (a && a.length < 8) throw Error(`@supabase/auth-js: Invalid SIWE message field "nonce". Nonce must be at least 8 characters. Provided value: ${a}`);
    if (!u) throw Error(`@supabase/auth-js: Invalid SIWE message field "uri". URI must be provided.`);
    if (d !== `1`) throw Error(`@supabase/auth-js: Invalid SIWE message field "version". Version must be '1'. Provided value: ${d}`);
    if ((_e$statement = e.statement) !== null && _e$statement !== void 0 && _e$statement.includes(`
`)) throw Error(`@supabase/auth-js: Invalid SIWE message field "statement". Statement must not include '\\n'. Provided value: ${e.statement}`);
    var f = Gr(e.address),
      p = `${l ? `${l}://${n}` : n} wants you to sign in with your Ethereum account:\n${f}\n\n${e.statement ? `${e.statement}\n` : ``}`,
      m = `URI: ${u}\nVersion: ${d}\nChain ID: ${t}${a ? `\nNonce: ${a}` : ``}\nIssued At: ${i.toISOString()}`;
    if (r && (m += `\nExpiration Time: ${r.toISOString()}`), o && (m += `\nNot Before: ${o.toISOString()}`), s && (m += `\nRequest ID: ${s}`), c) {
      var _e30 = `
Resources:`;
      var _iterator4 = _createForOfIteratorHelper(c),
        _step4;
      try {
        for (_iterator4.s(); !(_step4 = _iterator4.n()).done;) {
          var _t93 = _step4.value;
          if (!_t93 || typeof _t93 != `string`) throw Error(`@supabase/auth-js: Invalid SIWE message field "resources". Every resource must be a valid string. Provided value: ${_t93}`);
          _e30 += `\n- ${_t93}`;
        }
      } catch (err) {
        _iterator4.e(err);
      } finally {
        _iterator4.f();
      }
      m += _e30;
    }
    return `${p}\n${m}`;
  }
  var $ = class extends Error {
      constructor({
        message: e,
        code: t,
        cause: n,
        name: r
      }) {
        var _ref42;
        super(e, {
          cause: n
        }), this.__isWebAuthnError = !0, this.name = (_ref42 = r !== null && r !== void 0 ? r : n instanceof Error ? n.name : void 0) !== null && _ref42 !== void 0 ? _ref42 : `Unknown Error`, this.code = t;
      }
      toJSON() {
        return {
          name: this.name,
          message: this.message,
          code: this.code
        };
      }
    },
    Yr = class extends $ {
      constructor(e, t) {
        super({
          code: `ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY`,
          cause: t,
          message: e
        }), this.name = `WebAuthnUnknownError`, this.originalError = t;
      }
    };
  function Xr({
    error: e,
    options: t
  }) {
    var n = t.publicKey;
    if (!n) throw Error(`options was missing required publicKey property`);
    if (e.name === `AbortError`) {
      if (t.signal instanceof AbortSignal) return new $({
        message: `Registration ceremony was sent an abort signal`,
        code: `ERROR_CEREMONY_ABORTED`,
        cause: e
      });
    } else if (e.name === `ConstraintError`) {
      var _n$authenticatorSelec, _n$authenticatorSelec2, _n$authenticatorSelec3;
      if (((_n$authenticatorSelec = n.authenticatorSelection) === null || _n$authenticatorSelec === void 0 ? void 0 : _n$authenticatorSelec.requireResidentKey) === !0) return new $({
        message: `Discoverable credentials were required but no available authenticator supported it`,
        code: `ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT`,
        cause: e
      });
      if (t.mediation === `conditional` && ((_n$authenticatorSelec2 = n.authenticatorSelection) === null || _n$authenticatorSelec2 === void 0 ? void 0 : _n$authenticatorSelec2.userVerification) === `required`) return new $({
        message: `User verification was required during automatic registration but it could not be performed`,
        code: `ERROR_AUTO_REGISTER_USER_VERIFICATION_FAILURE`,
        cause: e
      });
      if (((_n$authenticatorSelec3 = n.authenticatorSelection) === null || _n$authenticatorSelec3 === void 0 ? void 0 : _n$authenticatorSelec3.userVerification) === `required`) return new $({
        message: `User verification was required but no available authenticator supported it`,
        code: `ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT`,
        cause: e
      });
    } else if (e.name === `InvalidStateError`) return new $({
      message: `The authenticator was previously registered`,
      code: `ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED`,
      cause: e
    });else if (e.name === `NotAllowedError`) return new $({
      message: e.message,
      code: `ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY`,
      cause: e
    });else if (e.name === `NotSupportedError`) return n.pubKeyCredParams.filter(e => e.type === `public-key`).length === 0 ? new $({
      message: `No entry in pubKeyCredParams was of type "public-key"`,
      code: `ERROR_MALFORMED_PUBKEYCREDPARAMS`,
      cause: e
    }) : new $({
      message: `No available authenticator supported any of the specified pubKeyCredParams algorithms`,
      code: `ERROR_AUTHENTICATOR_NO_SUPPORTED_PUBKEYCREDPARAMS_ALG`,
      cause: e
    });else if (e.name === `SecurityError`) {
      var _t94 = window.location.hostname;
      if (ri(_t94)) {
        if (n.rp.id !== _t94) return new $({
          message: `The RP ID "${n.rp.id}" is invalid for this domain`,
          code: `ERROR_INVALID_RP_ID`,
          cause: e
        });
      } else return new $({
        message: `${window.location.hostname} is an invalid domain`,
        code: `ERROR_INVALID_DOMAIN`,
        cause: e
      });
    } else if (e.name === `TypeError`) {
      if (n.user.id.byteLength < 1 || n.user.id.byteLength > 64) return new $({
        message: `User ID was not between 1 and 64 characters`,
        code: `ERROR_INVALID_USER_ID_LENGTH`,
        cause: e
      });
    } else if (e.name === `UnknownError`) return new $({
      message: `The authenticator was unable to process the specified options, or could not create a new credential`,
      code: `ERROR_AUTHENTICATOR_GENERAL_ERROR`,
      cause: e
    });
    return new $({
      message: `a Non-Webauthn related error has occurred`,
      code: `ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY`,
      cause: e
    });
  }
  function Zr({
    error: e,
    options: t
  }) {
    var n = t.publicKey;
    if (!n) throw Error(`options was missing required publicKey property`);
    if (e.name === `AbortError`) {
      if (t.signal instanceof AbortSignal) return new $({
        message: `Authentication ceremony was sent an abort signal`,
        code: `ERROR_CEREMONY_ABORTED`,
        cause: e
      });
    } else if (e.name === `NotAllowedError`) return new $({
      message: e.message,
      code: `ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY`,
      cause: e
    });else if (e.name === `SecurityError`) {
      var _t95 = window.location.hostname;
      if (ri(_t95)) {
        if (n.rpId !== _t95) return new $({
          message: `The RP ID "${n.rpId}" is invalid for this domain`,
          code: `ERROR_INVALID_RP_ID`,
          cause: e
        });
      } else return new $({
        message: `${window.location.hostname} is an invalid domain`,
        code: `ERROR_INVALID_DOMAIN`,
        cause: e
      });
    } else if (e.name === `UnknownError`) return new $({
      message: `The authenticator was unable to process the specified options, or could not create a new assertion signature`,
      code: `ERROR_AUTHENTICATOR_GENERAL_ERROR`,
      cause: e
    });
    return new $({
      message: `a Non-Webauthn related error has occurred`,
      code: `ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY`,
      cause: e
    });
  }
  var Qr = new class {
    createNewAbortSignal() {
      if (this.controller) {
        var _e31 = Error(`Cancelling existing WebAuthn API call for new one`);
        _e31.name = `AbortError`, this.controller.abort(_e31);
      }
      var e = new AbortController();
      return this.controller = e, e.signal;
    }
    cancelCeremony() {
      if (this.controller) {
        var _e32 = Error(`Manually cancelling existing WebAuthn API call`);
        _e32.name = `AbortError`, this.controller.abort(_e32), this.controller = void 0;
      }
    }
  }();
  function $r(e) {
    if (!e) throw Error(`Credential creation options are required`);
    if (typeof PublicKeyCredential < `u` && `parseCreationOptionsFromJSON` in PublicKeyCredential && typeof PublicKeyCredential.parseCreationOptionsFromJSON == `function`) return PublicKeyCredential.parseCreationOptionsFromJSON(e);
    var n = e.challenge,
      r = e.user,
      i = e.excludeCredentials,
      a = t(e, [`challenge`, `user`, `excludeCredentials`]),
      o = z(n).buffer,
      s = Object.assign(Object.assign({}, r), {
        id: z(r.id).buffer
      }),
      c = Object.assign(Object.assign({}, a), {
        challenge: o,
        user: s
      });
    if (i && i.length > 0) {
      c.excludeCredentials = Array(i.length);
      for (var _e33 = 0; _e33 < i.length; _e33++) {
        var _t96 = i[_e33];
        c.excludeCredentials[_e33] = Object.assign(Object.assign({}, _t96), {
          id: z(_t96.id).buffer,
          type: _t96.type || `public-key`,
          transports: _t96.transports
        });
      }
    }
    return c;
  }
  function ei(e) {
    if (!e) throw Error(`Credential request options are required`);
    if (typeof PublicKeyCredential < `u` && `parseRequestOptionsFromJSON` in PublicKeyCredential && typeof PublicKeyCredential.parseRequestOptionsFromJSON == `function`) return PublicKeyCredential.parseRequestOptionsFromJSON(e);
    var n = e.challenge,
      r = e.allowCredentials,
      i = t(e, [`challenge`, `allowCredentials`]),
      a = z(n).buffer,
      o = Object.assign(Object.assign({}, i), {
        challenge: a
      });
    if (r && r.length > 0) {
      o.allowCredentials = Array(r.length);
      for (var _e34 = 0; _e34 < r.length; _e34++) {
        var _t97 = r[_e34];
        o.allowCredentials[_e34] = Object.assign(Object.assign({}, _t97), {
          id: z(_t97.id).buffer,
          type: _t97.type || `public-key`,
          transports: _t97.transports
        });
      }
    }
    return o;
  }
  function ti(e) {
    var _t$authenticatorAttac;
    if (`toJSON` in e && typeof e.toJSON == `function`) return e.toJSON();
    var t = e;
    return {
      id: e.id,
      rawId: e.id,
      response: {
        attestationObject: B(new Uint8Array(e.response.attestationObject)),
        clientDataJSON: B(new Uint8Array(e.response.clientDataJSON))
      },
      type: `public-key`,
      clientExtensionResults: e.getClientExtensionResults(),
      authenticatorAttachment: (_t$authenticatorAttac = t.authenticatorAttachment) !== null && _t$authenticatorAttac !== void 0 ? _t$authenticatorAttac : void 0
    };
  }
  function ni(e) {
    var _t$authenticatorAttac2;
    if (`toJSON` in e && typeof e.toJSON == `function`) return e.toJSON();
    var t = e,
      n = e.getClientExtensionResults(),
      r = e.response;
    return {
      id: e.id,
      rawId: e.id,
      response: {
        authenticatorData: B(new Uint8Array(r.authenticatorData)),
        clientDataJSON: B(new Uint8Array(r.clientDataJSON)),
        signature: B(new Uint8Array(r.signature)),
        userHandle: r.userHandle ? B(new Uint8Array(r.userHandle)) : void 0
      },
      type: `public-key`,
      clientExtensionResults: n,
      authenticatorAttachment: (_t$authenticatorAttac2 = t.authenticatorAttachment) !== null && _t$authenticatorAttac2 !== void 0 ? _t$authenticatorAttac2 : void 0
    };
  }
  function ri(e) {
    return e === `localhost` || /^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z]{2,}$/i.test(e);
  }
  function ii() {
    var _ref43, _ref44;
    return !!(V() && `PublicKeyCredential` in window && window.PublicKeyCredential && `credentials` in navigator && typeof ((_ref43 = navigator == null ? void 0 : navigator.credentials) === null || _ref43 === void 0 ? void 0 : _ref43.create) == `function` && typeof ((_ref44 = navigator == null ? void 0 : navigator.credentials) === null || _ref44 === void 0 ? void 0 : _ref44.get) == `function`);
  }
  function ai(_x79) {
    return _ai.apply(this, arguments);
  }
  function _ai() {
    _ai = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee325(e) {
      var _t275, _t276;
      return _regenerator().w(function (_context326) {
        while (1) switch (_context326.p = _context326.n) {
          case 0:
            _context326.p = 0;
            _context326.n = 1;
            return navigator.credentials.create(e);
          case 1:
            _t275 = _context326.v;
            return _context326.a(2, _t275 ? _t275 instanceof PublicKeyCredential ? {
              data: _t275,
              error: null
            } : {
              data: null,
              error: new Yr(`Browser returned unexpected credential type`, _t275)
            } : {
              data: null,
              error: new Yr(`Empty credential response`, _t275)
            });
          case 2:
            _context326.p = 2;
            _t276 = _context326.v;
            return _context326.a(2, {
              data: null,
              error: Xr({
                error: _t276,
                options: e
              })
            });
        }
      }, _callee325, null, [[0, 2]]);
    }));
    return _ai.apply(this, arguments);
  }
  function oi(_x80) {
    return _oi.apply(this, arguments);
  }
  function _oi() {
    _oi = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee326(e) {
      var _t277, _t278;
      return _regenerator().w(function (_context327) {
        while (1) switch (_context327.p = _context327.n) {
          case 0:
            _context327.p = 0;
            _context327.n = 1;
            return navigator.credentials.get(e);
          case 1:
            _t277 = _context327.v;
            return _context327.a(2, _t277 ? _t277 instanceof PublicKeyCredential ? {
              data: _t277,
              error: null
            } : {
              data: null,
              error: new Yr(`Browser returned unexpected credential type`, _t277)
            } : {
              data: null,
              error: new Yr(`Empty credential response`, _t277)
            });
          case 2:
            _context327.p = 2;
            _t278 = _context327.v;
            return _context327.a(2, {
              data: null,
              error: Zr({
                error: _t278,
                options: e
              })
            });
        }
      }, _callee326, null, [[0, 2]]);
    }));
    return _oi.apply(this, arguments);
  }
  var si = {
      hints: [`security-key`],
      authenticatorSelection: {
        authenticatorAttachment: `cross-platform`,
        requireResidentKey: !1,
        userVerification: `preferred`,
        residentKey: `discouraged`
      },
      attestation: `direct`
    },
    ci = {
      userVerification: `preferred`,
      hints: [`security-key`],
      attestation: `direct`
    };
  function li(...e) {
    var t = e => typeof e == `object` && !!e && !Array.isArray(e),
      n = e => e instanceof ArrayBuffer || ArrayBuffer.isView(e),
      r = {};
    for (var _i13 = 0, _e35 = e; _i13 < _e35.length; _i13++) {
      var i = _e35[_i13];
      if (i) for (var _e36 in i) {
        var a = i[_e36];
        if (a !== void 0) if (Array.isArray(a)) r[_e36] = a;else if (n(a)) r[_e36] = a;else if (t(a)) {
          var _n11 = r[_e36];
          t(_n11) ? r[_e36] = li(_n11, a) : r[_e36] = li(a);
        } else r[_e36] = a;
      }
    }
    return r;
  }
  function ui(e, t) {
    return li(si, e, t || {});
  }
  function di(e, t) {
    return li(ci, e, t || {});
  }
  var fi = class {
    constructor(e) {
      this.client = e, this.enroll = this._enroll.bind(this), this.challenge = this._challenge.bind(this), this.verify = this._verify.bind(this), this.authenticate = this._authenticate.bind(this), this.register = this._register.bind(this);
    }
    _enroll(e) {
      var _this116 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee169() {
        return _regenerator().w(function (_context170) {
          while (1) switch (_context170.n) {
            case 0:
              return _context170.a(2, _this116.client.mfa.enroll(Object.assign(Object.assign({}, e), {
                factorType: `webauthn`
              })));
          }
        }, _callee169);
      }))();
    }
    _challenge(_x81, _x82) {
      var _this117 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee170({
        factorId: e,
        webauthn: t,
        friendlyName: n,
        signal: r
      }, i) {
        var _yield$_this117$clien, a, o, s, _e37, _t98, _t99$user_metadata, _t99, _n12, _yield$ai, _t100, _n13, _t101, _yield$oi, _n14, _r0, _t102, _t103;
        return _regenerator().w(function (_context171) {
          while (1) switch (_context171.p = _context171.n) {
            case 0:
              _context171.p = 0;
              _context171.n = 1;
              return _this117.client.mfa.challenge({
                factorId: e,
                webauthn: t
              });
            case 1:
              _yield$_this117$clien = _context171.v;
              a = _yield$_this117$clien.data;
              o = _yield$_this117$clien.error;
              if (a) {
                _context171.n = 2;
                break;
              }
              return _context171.a(2, {
                data: null,
                error: o
              });
            case 2:
              s = r !== null && r !== void 0 ? r : Qr.createNewAbortSignal();
              if (!(a.webauthn.type === `create`)) {
                _context171.n = 6;
                break;
              }
              _e37 = a.webauthn.credential_options.publicKey.user;
              if (_e37.name) {
                _context171.n = 5;
                break;
              }
              _t98 = n;
              if (!_t98) {
                _context171.n = 3;
                break;
              }
              _e37.name = `${_e37.id}:${_t98}`;
              _context171.n = 5;
              break;
            case 3:
              _context171.n = 4;
              return _this117.client.getUser();
            case 4:
              _t99 = _context171.v.data.user;
              _n12 = (_t99 === null || _t99 === void 0 || (_t99$user_metadata = _t99.user_metadata) === null || _t99$user_metadata === void 0 ? void 0 : _t99$user_metadata.name) || (_t99 === null || _t99 === void 0 ? void 0 : _t99.email) || (_t99 === null || _t99 === void 0 ? void 0 : _t99.id) || `User`;
              _e37.name = `${_e37.id}:${_n12}`;
            case 5:
              _e37.displayName || (_e37.displayName = _e37.name);
            case 6:
              _t102 = a.webauthn.type;
              _context171.n = _t102 === `create` ? 7 : _t102 === `request` ? 9 : 11;
              break;
            case 7:
              _context171.n = 8;
              return ai({
                publicKey: ui(a.webauthn.credential_options.publicKey, i === null || i === void 0 ? void 0 : i.create),
                signal: s
              });
            case 8:
              _yield$ai = _context171.v;
              _t100 = _yield$ai.data;
              _n13 = _yield$ai.error;
              return _context171.a(2, _t100 ? {
                data: {
                  factorId: e,
                  challengeId: a.id,
                  webauthn: {
                    type: a.webauthn.type,
                    credential_response: _t100
                  }
                },
                error: null
              } : {
                data: null,
                error: _n13
              });
            case 9:
              _t101 = di(a.webauthn.credential_options.publicKey, i === null || i === void 0 ? void 0 : i.request);
              _context171.n = 10;
              return oi(Object.assign(Object.assign({}, a.webauthn.credential_options), {
                publicKey: _t101,
                signal: s
              }));
            case 10:
              _yield$oi = _context171.v;
              _n14 = _yield$oi.data;
              _r0 = _yield$oi.error;
              return _context171.a(2, _n14 ? {
                data: {
                  factorId: e,
                  challengeId: a.id,
                  webauthn: {
                    type: a.webauthn.type,
                    credential_response: _n14
                  }
                },
                error: null
              } : {
                data: null,
                error: _r0
              });
            case 11:
              _context171.n = 13;
              break;
            case 12:
              _context171.p = 12;
              _t103 = _context171.v;
              return _context171.a(2, P(_t103) ? {
                data: null,
                error: _t103
              } : {
                data: null,
                error: new F(`Unexpected error in challenge`, _t103)
              });
            case 13:
              return _context171.a(2);
          }
        }, _callee170, null, [[0, 12]]);
      })).apply(this, arguments);
    }
    _verify(_x83) {
      var _this118 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee171({
        challengeId: e,
        factorId: t,
        webauthn: n
      }) {
        return _regenerator().w(function (_context172) {
          while (1) switch (_context172.n) {
            case 0:
              return _context172.a(2, _this118.client.mfa.verify({
                factorId: t,
                challengeId: e,
                webauthn: n
              }));
          }
        }, _callee171);
      })).apply(this, arguments);
    }
    _authenticate(_x84, _x85) {
      var _this119 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee172({
        factorId: e,
        webauthn: {
          rpId: t = typeof window < `u` ? window.location.hostname : void 0,
          rpOrigins: n = typeof window < `u` ? [window.location.origin] : void 0,
          signal: r
        } = {}
      }, i) {
        var _yield$_this119$chall, a, o, s, _t104;
        return _regenerator().w(function (_context173) {
          while (1) switch (_context173.p = _context173.n) {
            case 0:
              if (t) {
                _context173.n = 1;
                break;
              }
              return _context173.a(2, {
                data: null,
                error: new N(`rpId is required for WebAuthn authentication`)
              });
            case 1:
              _context173.p = 1;
              if (ii()) {
                _context173.n = 2;
                break;
              }
              return _context173.a(2, {
                data: null,
                error: new F(`Browser does not support WebAuthn`, null)
              });
            case 2:
              _context173.n = 3;
              return _this119.challenge({
                factorId: e,
                webauthn: {
                  rpId: t,
                  rpOrigins: n
                },
                signal: r
              }, {
                request: i
              });
            case 3:
              _yield$_this119$chall = _context173.v;
              a = _yield$_this119$chall.data;
              o = _yield$_this119$chall.error;
              if (a) {
                _context173.n = 4;
                break;
              }
              return _context173.a(2, {
                data: null,
                error: o
              });
            case 4:
              s = a.webauthn;
              return _context173.a(2, _this119._verify({
                factorId: e,
                challengeId: a.challengeId,
                webauthn: {
                  type: s.type,
                  rpId: t,
                  rpOrigins: n,
                  credential_response: s.credential_response
                }
              }));
            case 5:
              _context173.p = 5;
              _t104 = _context173.v;
              return _context173.a(2, P(_t104) ? {
                data: null,
                error: _t104
              } : {
                data: null,
                error: new F(`Unexpected error in authenticate`, _t104)
              });
          }
        }, _callee172, null, [[1, 5]]);
      })).apply(this, arguments);
    }
    _register(_x86, _x87) {
      var _this120 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee173({
        friendlyName: e,
        webauthn: {
          rpId: t = typeof window < `u` ? window.location.hostname : void 0,
          rpOrigins: n = typeof window < `u` ? [window.location.origin] : void 0,
          signal: r
        } = {}
      }, i) {
        var _yield$_this120$_enro, a, o, _yield$_this120$_chal, s, c, _t105;
        return _regenerator().w(function (_context174) {
          while (1) switch (_context174.p = _context174.n) {
            case 0:
              if (t) {
                _context174.n = 1;
                break;
              }
              return _context174.a(2, {
                data: null,
                error: new N(`rpId is required for WebAuthn registration`)
              });
            case 1:
              _context174.p = 1;
              if (ii()) {
                _context174.n = 2;
                break;
              }
              return _context174.a(2, {
                data: null,
                error: new F(`Browser does not support WebAuthn`, null)
              });
            case 2:
              _context174.n = 3;
              return _this120._enroll({
                friendlyName: e
              });
            case 3:
              _yield$_this120$_enro = _context174.v;
              a = _yield$_this120$_enro.data;
              o = _yield$_this120$_enro.error;
              if (a) {
                _context174.n = 5;
                break;
              }
              _context174.n = 4;
              return _this120.client.mfa.listFactors().then(t => {
                var _t$data2;
                return (_t$data2 = t.data) === null || _t$data2 === void 0 ? void 0 : _t$data2.all.find(t => t.factor_type === `webauthn` && t.friendly_name === e && t.status !== `unverified`);
              }).then(e => e ? _this120.client.mfa.unenroll({
                factorId: e === null || e === void 0 ? void 0 : e.id
              }) : void 0);
            case 4:
              return _context174.a(2, {
                data: null,
                error: o
              });
            case 5:
              _context174.n = 6;
              return _this120._challenge({
                factorId: a.id,
                friendlyName: a.friendly_name,
                webauthn: {
                  rpId: t,
                  rpOrigins: n
                },
                signal: r
              }, {
                create: i
              });
            case 6:
              _yield$_this120$_chal = _context174.v;
              s = _yield$_this120$_chal.data;
              c = _yield$_this120$_chal.error;
              return _context174.a(2, s ? _this120._verify({
                factorId: a.id,
                challengeId: s.challengeId,
                webauthn: {
                  rpId: t,
                  rpOrigins: n,
                  type: s.webauthn.type,
                  credential_response: s.webauthn.credential_response
                }
              }) : {
                data: null,
                error: c
              });
            case 7:
              _context174.p = 7;
              _t105 = _context174.v;
              return _context174.a(2, P(_t105) ? {
                data: null,
                error: _t105
              } : {
                data: null,
                error: new F(`Unexpected error in register`, _t105)
              });
          }
        }, _callee173, null, [[1, 7]]);
      })).apply(this, arguments);
    }
  };
  Wr();
  var pi = {
      url: `http://localhost:9999`,
      storageKey: `supabase.auth.token`,
      autoRefreshToken: !0,
      persistSession: !0,
      detectSessionInUrl: !0,
      headers: Dn,
      flowType: `implicit`,
      debug: !1,
      hasCustomAuthorizationHeader: !1,
      throwOnError: !1,
      lockAcquireTimeout: 5e3,
      skipAutoInitialize: !1,
      experimental: {}
    },
    mi = {};
  var hi = class e {
    get jwks() {
      var _mi$this$storageKey$j, _mi$this$storageKey;
      return (_mi$this$storageKey$j = (_mi$this$storageKey = mi[this.storageKey]) === null || _mi$this$storageKey === void 0 ? void 0 : _mi$this$storageKey.jwks) !== null && _mi$this$storageKey$j !== void 0 ? _mi$this$storageKey$j : {
        keys: []
      };
    }
    set jwks(e) {
      mi[this.storageKey] = Object.assign(Object.assign({}, mi[this.storageKey]), {
        jwks: e
      });
    }
    get jwks_cached_at() {
      var _mi$this$storageKey$c, _mi$this$storageKey2;
      return (_mi$this$storageKey$c = (_mi$this$storageKey2 = mi[this.storageKey]) === null || _mi$this$storageKey2 === void 0 ? void 0 : _mi$this$storageKey2.cachedAt) !== null && _mi$this$storageKey$c !== void 0 ? _mi$this$storageKey$c : -(Math.pow(2, 53) - 1);
    }
    set jwks_cached_at(e) {
      mi[this.storageKey] = Object.assign(Object.assign({}, mi[this.storageKey]), {
        cachedAt: e
      });
    }
    constructor(t) {
      var _e$nextInstanceID$thi,
        _r$experimental,
        _this121 = this;
      var n;
      this.userStorage = null, this.memoryStorage = null, this.stateChangeEmitters = new Map(), this.autoRefreshTicker = null, this.autoRefreshTickTimeout = null, this.visibilityChangedCallback = null, this.refreshingDeferred = null, this.lastRefreshFailure = null, this._sessionRemovalEpoch = 0, this.initializePromise = null, this.detectSessionInUrl = !0, this.hasCustomAuthorizationHeader = !1, this.suppressGetSessionWarning = !1, this.lock = null, this.lockAcquired = !1, this.pendingInLock = [], this.broadcastChannel = null, this.logger = console.log;
      var r = Object.assign(Object.assign({}, pi), t);
      if (this.storageKey = r.storageKey, this.instanceID = (_e$nextInstanceID$thi = e.nextInstanceID[this.storageKey]) !== null && _e$nextInstanceID$thi !== void 0 ? _e$nextInstanceID$thi : 0, e.nextInstanceID[this.storageKey] = this.instanceID + 1, this.logDebugMessages = !!r.debug, typeof r.debug == `function` && (this.logger = r.debug), this.instanceID > 0 && V()) {
        var _e38 = `${this._logPrefix()} Multiple GoTrueClient instances detected in the same browser context. It is not an error, but this should be avoided as it may produce undefined behavior when used concurrently under the same storage key.`;
        console.warn(_e38), this.logDebugMessages && console.trace(_e38);
      }
      if (this.persistSession = r.persistSession, this.autoRefreshToken = r.autoRefreshToken, this.experimental = (_r$experimental = r.experimental) !== null && _r$experimental !== void 0 ? _r$experimental : {}, this.admin = new Ir({
        url: r.url,
        headers: r.headers,
        fetch: r.fetch,
        experimental: this.experimental
      }), this.url = r.url, this.headers = r.headers, this.fetch = sr(r.fetch), this.detectSessionInUrl = r.detectSessionInUrl, this.flowType = r.flowType, this.hasCustomAuthorizationHeader = r.hasCustomAuthorizationHeader, this.throwOnError = r.throwOnError, this.lockAcquireTimeout = r.lockAcquireTimeout, r.lock != null && (this.lock = r.lock), this.jwks || (this.jwks = {
        keys: []
      }, this.jwks_cached_at = -(Math.pow(2, 53) - 1)), this.mfa = {
        verify: this._verify.bind(this),
        enroll: this._enroll.bind(this),
        unenroll: this._unenroll.bind(this),
        challenge: this._challenge.bind(this),
        listFactors: this._listFactors.bind(this),
        challengeAndVerify: this._challengeAndVerify.bind(this),
        getAuthenticatorAssuranceLevel: this._getAuthenticatorAssuranceLevel.bind(this),
        webauthn: new fi(this)
      }, this.oauth = {
        getAuthorizationDetails: this._getAuthorizationDetails.bind(this),
        approveAuthorization: this._approveAuthorization.bind(this),
        denyAuthorization: this._denyAuthorization.bind(this),
        listGrants: this._listOAuthGrants.bind(this),
        revokeGrant: this._revokeOAuthGrant.bind(this)
      }, this.passkey = {
        startRegistration: this._startPasskeyRegistration.bind(this),
        verifyRegistration: this._verifyPasskeyRegistration.bind(this),
        startAuthentication: this._startPasskeyAuthentication.bind(this),
        verifyAuthentication: this._verifyPasskeyAuthentication.bind(this),
        list: this._listPasskeys.bind(this),
        update: this._updatePasskey.bind(this),
        delete: this._deletePasskey.bind(this)
      }, this.persistSession ? (r.storage ? this.storage = r.storage : ar() ? this.storage = globalThis.localStorage : (this.memoryStorage = {}, this.storage = Lr(this.memoryStorage)), r.userStorage && (this.userStorage = r.userStorage)) : (this.memoryStorage = {}, this.storage = Lr(this.memoryStorage)), V() && globalThis.BroadcastChannel && this.persistSession && this.storageKey) {
        try {
          this.broadcastChannel = new globalThis.BroadcastChannel(this.storageKey);
        } catch (e) {
          console.error(`Failed to create a new BroadcastChannel, multi-tab state changes will not be available`, e);
        }
        (n = this.broadcastChannel) == null || n.addEventListener(`message`, /*#__PURE__*/function () {
          var _ref45 = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee174(e) {
            var _t106;
            return _regenerator().w(function (_context175) {
              while (1) switch (_context175.p = _context175.n) {
                case 0:
                  _this121._debug(`received broadcast notification from other tab or client`, e), (e.data.event === `TOKEN_REFRESHED` || e.data.event === `SIGNED_IN`) && (_this121.lastRefreshFailure = null);
                  _context175.p = 1;
                  _context175.n = 2;
                  return _this121._notifyAllSubscribers(e.data.event, e.data.session, !1);
                case 2:
                  _context175.n = 4;
                  break;
                case 3:
                  _context175.p = 3;
                  _t106 = _context175.v;
                  _this121._debug(`#broadcastChannel`, `error`, _t106);
                case 4:
                  return _context175.a(2);
              }
            }, _callee174, null, [[1, 3]]);
          }));
          return function (_x88) {
            return _ref45.apply(this, arguments);
          };
        }());
      }
      r.skipAutoInitialize || this.initialize().catch(e => {
        this._debug(`#initialize()`, `error`, e);
      });
    }
    isThrowOnErrorEnabled() {
      return this.throwOnError;
    }
    _returnResult(e) {
      if (this.throwOnError && e && e.error) throw e.error;
      return e;
    }
    _logPrefix() {
      return `GoTrueClient@${this.storageKey}:${this.instanceID} (${Tn}) ${new Date().toISOString()}`;
    }
    _debug(...e) {
      return this.logDebugMessages && this.logger(this._logPrefix(), ...e), this;
    }
    initialize() {
      var _this122 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee177() {
        return _regenerator().w(function (_context178) {
          while (1) switch (_context178.n) {
            case 0:
              _this122.initializePromise || (_this122.initializePromise = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee176() {
                var _t107;
                return _regenerator().w(function (_context177) {
                  while (1) switch (_context177.n) {
                    case 0:
                      if (!(_this122.lock == null)) {
                        _context177.n = 2;
                        break;
                      }
                      _context177.n = 1;
                      return _this122._initialize();
                    case 1:
                      _t107 = _context177.v;
                      _context177.n = 4;
                      break;
                    case 2:
                      _context177.n = 3;
                      return _this122._acquireLock(_this122.lockAcquireTimeout, /*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee175() {
                        return _regenerator().w(function (_context176) {
                          while (1) switch (_context176.n) {
                            case 0:
                              _context176.n = 1;
                              return _this122._initialize();
                            case 1:
                              return _context176.a(2, _context176.v);
                          }
                        }, _callee175);
                      })));
                    case 3:
                      _t107 = _context177.v;
                    case 4:
                      return _context177.a(2, _t107);
                  }
                }, _callee176);
              }))());
              _context178.n = 1;
              return _this122.initializePromise;
            case 1:
              return _context178.a(2, _context178.v);
          }
        }, _callee177);
      }))();
    }
    _initialize() {
      var _this123 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee179() {
        var _e39, _t108, _yield$_this123$_getS, n, r, _r$details, _e40, i, a, _t109, _t110, _t111;
        return _regenerator().w(function (_context180) {
          while (1) switch (_context180.p = _context180.n) {
            case 0:
              _context180.p = 0;
              _e39 = {}, _t108 = `none`;
              _t109 = V();
              if (!_t109) {
                _context180.n = 3;
                break;
              }
              _e39 = or(window.location.href);
              if (!_this123._isImplicitGrantCallback(_e39)) {
                _context180.n = 1;
                break;
              }
              _t108 = `implicit`;
              _context180.n = 3;
              break;
            case 1:
              _context180.n = 2;
              return _this123._isPKCECallback(_e39);
            case 2:
              _t110 = _context180.v;
              if (!_t110) {
                _context180.n = 3;
                break;
              }
              _t108 = `pkce`;
            case 3:
              if (!(V() && _this123.detectSessionInUrl && _t108 !== `none`)) {
                _context180.n = 8;
                break;
              }
              _context180.n = 4;
              return _this123._getSessionFromURL(_e39, _t108);
            case 4:
              _yield$_this123$_getS = _context180.v;
              n = _yield$_this123$_getS.data;
              r = _yield$_this123$_getS.error;
              if (!r) {
                _context180.n = 6;
                break;
              }
              if (!(_this123._debug(`#_initialize()`, `error detecting session from URL`, r), In(r))) {
                _context180.n = 5;
                break;
              }
              _e40 = (_r$details = r.details) === null || _r$details === void 0 ? void 0 : _r$details.code;
              if (!(_e40 === `identity_already_exists` || _e40 === `identity_not_found` || _e40 === `single_identity_not_deletable`)) {
                _context180.n = 5;
                break;
              }
              return _context180.a(2, {
                error: r
              });
            case 5:
              return _context180.a(2, {
                error: r
              });
            case 6:
              i = n.session, a = n.redirectType;
              _this123._debug(`#_initialize()`, `detected session in URL`, i, `redirect type`, a);
              _context180.n = 7;
              return _this123._saveSession(i);
            case 7:
              setTimeout(/*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee178() {
                return _regenerator().w(function (_context179) {
                  while (1) switch (_context179.n) {
                    case 0:
                      if (!(a === `recovery`)) {
                        _context179.n = 2;
                        break;
                      }
                      _context179.n = 1;
                      return _this123._notifyAllSubscribers(`PASSWORD_RECOVERY`, i);
                    case 1:
                      _context179.n = 3;
                      break;
                    case 2:
                      _context179.n = 3;
                      return _this123._notifyAllSubscribers(`SIGNED_IN`, i);
                    case 3:
                      return _context179.a(2);
                  }
                }, _callee178);
              })), 0);
              return _context180.a(2, {
                error: null
              });
            case 8:
              _context180.n = 9;
              return _this123._recoverAndRefresh();
            case 9:
              return _context180.a(2, {
                error: null
              });
            case 10:
              _context180.p = 10;
              _t111 = _context180.v;
              return _context180.a(2, P(_t111) ? _this123._returnResult({
                error: _t111
              }) : _this123._returnResult({
                error: new F(`Unexpected error during initialization`, _t111)
              }));
            case 11:
              _context180.p = 11;
              _context180.n = 12;
              return _this123._handleVisibilityChange();
            case 12:
              _this123._debug(`#_initialize()`, `end`);
              return _context180.f(11);
            case 13:
              return _context180.a(2);
          }
        }, _callee179, null, [[0, 10, 11, 13]]);
      }))();
    }
    signInAnonymously(e) {
      var _this124 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee180() {
        var _e$options$data, _e$options, _e$options2, _yield$Y2, _t112, n, r, i, _t113, _t114;
        return _regenerator().w(function (_context181) {
          while (1) switch (_context181.p = _context181.n) {
            case 0:
              _context181.p = 0;
              _context181.n = 1;
              return Y(_this124.fetch, `POST`, `${_this124.url}/signup`, {
                headers: _this124.headers,
                body: {
                  data: (_e$options$data = e === null || e === void 0 || (_e$options = e.options) === null || _e$options === void 0 ? void 0 : _e$options.data) !== null && _e$options$data !== void 0 ? _e$options$data : {},
                  gotrue_meta_security: {
                    captcha_token: e === null || e === void 0 || (_e$options2 = e.options) === null || _e$options2 === void 0 ? void 0 : _e$options2.captchaToken
                  }
                },
                xform: X
              });
            case 1:
              _yield$Y2 = _context181.v;
              _t112 = _yield$Y2.data;
              n = _yield$Y2.error;
              if (!(n || !_t112)) {
                _context181.n = 2;
                break;
              }
              return _context181.a(2, _this124._returnResult({
                data: {
                  user: null,
                  session: null
                },
                error: n
              }));
            case 2:
              r = _t112.session, i = _t112.user;
              _t113 = _t112.session;
              if (!_t113) {
                _context181.n = 4;
                break;
              }
              _context181.n = 3;
              return _this124._saveSession(_t112.session);
            case 3:
              _context181.n = 4;
              return _this124._notifyAllSubscribers(`SIGNED_IN`, r);
            case 4:
              return _context181.a(2, _this124._returnResult({
                data: {
                  user: i,
                  session: r
                },
                error: null
              }));
            case 5:
              _context181.p = 5;
              _t114 = _context181.v;
              if (!P(_t114)) {
                _context181.n = 6;
                break;
              }
              return _context181.a(2, _this124._returnResult({
                data: {
                  user: null,
                  session: null
                },
                error: _t114
              }));
            case 6:
              throw _t114;
            case 7:
              return _context181.a(2);
          }
        }, _callee180, null, [[0, 5]]);
      }))();
    }
    signUp(e) {
      var _this125 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee181() {
        var _t115, _yield$G, _yield$G2, _i14$data, _n15, _r1, _i14, _a, o, _i15$data, _i15$channel, _n16, _r10, _i15, _t116, n, r, i, a, _t117, _t118, _t119;
        return _regenerator().w(function (_context182) {
          while (1) switch (_context182.p = _context182.n) {
            case 0:
              _context182.p = 0;
              if (!(`email` in e)) {
                _context182.n = 4;
                break;
              }
              _n15 = e.email, _r1 = e.password, _i14 = e.options, _a = null, o = null;
              _t117 = _this125.flowType === `pkce`;
              if (!_t117) {
                _context182.n = 2;
                break;
              }
              _context182.n = 1;
              return G(_this125.storage, _this125.storageKey);
            case 1:
              _yield$G = _context182.v;
              _yield$G2 = _slicedToArray(_yield$G, 2);
              _a = _yield$G2[0];
              o = _yield$G2[1];
              _yield$G;
            case 2:
              _context182.n = 3;
              return Y(_this125.fetch, `POST`, `${_this125.url}/signup`, {
                headers: _this125.headers,
                redirectTo: _i14 === null || _i14 === void 0 ? void 0 : _i14.emailRedirectTo,
                body: {
                  email: _n15,
                  password: _r1,
                  data: (_i14$data = _i14 === null || _i14 === void 0 ? void 0 : _i14.data) !== null && _i14$data !== void 0 ? _i14$data : {},
                  gotrue_meta_security: {
                    captcha_token: _i14 === null || _i14 === void 0 ? void 0 : _i14.captchaToken
                  },
                  code_challenge: _a,
                  code_challenge_method: o
                },
                xform: X
              });
            case 3:
              _t115 = _context182.v;
              _context182.n = 7;
              break;
            case 4:
              if (!(`phone` in e)) {
                _context182.n = 6;
                break;
              }
              _n16 = e.phone, _r10 = e.password, _i15 = e.options;
              _context182.n = 5;
              return Y(_this125.fetch, `POST`, `${_this125.url}/signup`, {
                headers: _this125.headers,
                body: {
                  phone: _n16,
                  password: _r10,
                  data: (_i15$data = _i15 === null || _i15 === void 0 ? void 0 : _i15.data) !== null && _i15$data !== void 0 ? _i15$data : {},
                  channel: (_i15$channel = _i15 === null || _i15 === void 0 ? void 0 : _i15.channel) !== null && _i15$channel !== void 0 ? _i15$channel : `sms`,
                  gotrue_meta_security: {
                    captcha_token: _i15 === null || _i15 === void 0 ? void 0 : _i15.captchaToken
                  }
                },
                xform: X
              });
            case 5:
              _t115 = _context182.v;
              _context182.n = 7;
              break;
            case 6:
              throw new Pn(`You must provide either an email or phone number and a password`);
            case 7:
              _t116 = _t115, n = _t116.data, r = _t116.error;
              if (!(r || !n)) {
                _context182.n = 9;
                break;
              }
              _context182.n = 8;
              return W(_this125.storage, `${_this125.storageKey}-code-verifier`);
            case 8:
              return _context182.a(2, _this125._returnResult({
                data: {
                  user: null,
                  session: null
                },
                error: r
              }));
            case 9:
              i = n.session, a = n.user;
              _t118 = n.session;
              if (!_t118) {
                _context182.n = 11;
                break;
              }
              _context182.n = 10;
              return _this125._saveSession(n.session);
            case 10:
              _context182.n = 11;
              return _this125._notifyAllSubscribers(`SIGNED_IN`, i);
            case 11:
              return _context182.a(2, _this125._returnResult({
                data: {
                  user: a,
                  session: i
                },
                error: null
              }));
            case 12:
              _context182.p = 12;
              _t119 = _context182.v;
              _context182.n = 13;
              return W(_this125.storage, `${_this125.storageKey}-code-verifier`);
            case 13:
              if (!P(_t119)) {
                _context182.n = 14;
                break;
              }
              return _context182.a(2, _this125._returnResult({
                data: {
                  user: null,
                  session: null
                },
                error: _t119
              }));
            case 14:
              throw _t119;
            case 15:
              return _context182.a(2);
          }
        }, _callee181, null, [[0, 12]]);
      }))();
    }
    signInWithPassword(e) {
      var _this126 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee182() {
        var _t120, _n17, _r11, i, _n18, _r12, _i16, _t121, n, r, _e41, _t122, _t123;
        return _regenerator().w(function (_context183) {
          while (1) switch (_context183.p = _context183.n) {
            case 0:
              _context183.p = 0;
              if (!(`email` in e)) {
                _context183.n = 2;
                break;
              }
              _n17 = e.email, _r11 = e.password, i = e.options;
              _context183.n = 1;
              return Y(_this126.fetch, `POST`, `${_this126.url}/token?grant_type=password`, {
                headers: _this126.headers,
                body: {
                  email: _n17,
                  password: _r11,
                  gotrue_meta_security: {
                    captcha_token: i === null || i === void 0 ? void 0 : i.captchaToken
                  }
                },
                xform: Ar
              });
            case 1:
              _t120 = _context183.v;
              _context183.n = 5;
              break;
            case 2:
              if (!(`phone` in e)) {
                _context183.n = 4;
                break;
              }
              _n18 = e.phone, _r12 = e.password, _i16 = e.options;
              _context183.n = 3;
              return Y(_this126.fetch, `POST`, `${_this126.url}/token?grant_type=password`, {
                headers: _this126.headers,
                body: {
                  phone: _n18,
                  password: _r12,
                  gotrue_meta_security: {
                    captcha_token: _i16 === null || _i16 === void 0 ? void 0 : _i16.captchaToken
                  }
                },
                xform: Ar
              });
            case 3:
              _t120 = _context183.v;
              _context183.n = 5;
              break;
            case 4:
              throw new Pn(`You must provide either an email or phone number and a password`);
            case 5:
              _t121 = _t120, n = _t121.data, r = _t121.error;
              if (!r) {
                _context183.n = 6;
                break;
              }
              return _context183.a(2, _this126._returnResult({
                data: {
                  user: null,
                  session: null
                },
                error: r
              }));
            case 6:
              if (!(!n || !n.session || !n.user)) {
                _context183.n = 7;
                break;
              }
              _e41 = new R();
              return _context183.a(2, _this126._returnResult({
                data: {
                  user: null,
                  session: null
                },
                error: _e41
              }));
            case 7:
              _t122 = n.session;
              if (!_t122) {
                _context183.n = 9;
                break;
              }
              _context183.n = 8;
              return _this126._saveSession(n.session);
            case 8:
              _context183.n = 9;
              return _this126._notifyAllSubscribers(`SIGNED_IN`, n.session);
            case 9:
              return _context183.a(2, _this126._returnResult({
                data: Object.assign({
                  user: n.user,
                  session: n.session
                }, n.weak_password ? {
                  weakPassword: n.weak_password
                } : null),
                error: r
              }));
            case 10:
              _context183.p = 10;
              _t123 = _context183.v;
              if (!P(_t123)) {
                _context183.n = 11;
                break;
              }
              return _context183.a(2, _this126._returnResult({
                data: {
                  user: null,
                  session: null
                },
                error: _t123
              }));
            case 11:
              throw _t123;
            case 12:
              return _context183.a(2);
          }
        }, _callee182, null, [[0, 10]]);
      }))();
    }
    signInWithOAuth(e) {
      var _this127 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee183() {
        var _e$options3, _e$options4, _e$options5, _e$options6;
        return _regenerator().w(function (_context184) {
          while (1) switch (_context184.n) {
            case 0:
              _context184.n = 1;
              return _this127._handleProviderSignIn(e.provider, {
                redirectTo: (_e$options3 = e.options) === null || _e$options3 === void 0 ? void 0 : _e$options3.redirectTo,
                scopes: (_e$options4 = e.options) === null || _e$options4 === void 0 ? void 0 : _e$options4.scopes,
                queryParams: (_e$options5 = e.options) === null || _e$options5 === void 0 ? void 0 : _e$options5.queryParams,
                skipBrowserRedirect: (_e$options6 = e.options) === null || _e$options6 === void 0 ? void 0 : _e$options6.skipBrowserRedirect
              });
            case 1:
              return _context184.a(2, _context184.v);
          }
        }, _callee183);
      }))();
    }
    exchangeCodeForSession(e) {
      var _this128 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee185() {
        return _regenerator().w(function (_context186) {
          while (1) switch (_context186.n) {
            case 0:
              _context186.n = 1;
              return _this128.initializePromise;
            case 1:
              return _context186.a(2, _this128.lock == null ? _this128._exchangeCodeForSession(e) : _this128._acquireLock(_this128.lockAcquireTimeout, /*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee184() {
                return _regenerator().w(function (_context185) {
                  while (1) switch (_context185.n) {
                    case 0:
                      return _context185.a(2, _this128._exchangeCodeForSession(e));
                  }
                }, _callee184);
              }))));
          }
        }, _callee185);
      }))();
    }
    signInWithWeb3(e) {
      var _this129 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee186() {
        var t, _t124;
        return _regenerator().w(function (_context187) {
          while (1) switch (_context187.n) {
            case 0:
              t = e.chain;
              _t124 = t;
              _context187.n = _t124 === `ethereum` ? 1 : _t124 === `solana` ? 3 : 5;
              break;
            case 1:
              _context187.n = 2;
              return _this129.signInWithEthereum(e);
            case 2:
              return _context187.a(2, _context187.v);
            case 3:
              _context187.n = 4;
              return _this129.signInWithSolana(e);
            case 4:
              return _context187.a(2, _context187.v);
            case 5:
              throw Error(`@supabase/auth-js: Unsupported chain "${t}"`);
            case 6:
              return _context187.a(2);
          }
        }, _callee186);
      }))();
    }
    signInWithEthereum(e) {
      var _this130 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee187() {
        var t, n, _o$url, _o$signInWithEthereum, _o$signInWithEthereum2, _o$signInWithEthereum3, _o$signInWithEthereum4, _o$signInWithEthereum5, _o$signInWithEthereum6, _o$signInWithEthereum7, _o$signInWithEthereum8, r, i, a, o, s, _e42, c, _l3, _u3, _d3, _e$options7, _e$options8, _yield$Y3, _r13, _i17, _e43, _t125, _t126, _t127, _t128;
        return _regenerator().w(function (_context188) {
          while (1) switch (_context188.p = _context188.n) {
            case 0:
              if (!(`message` in e)) {
                _context188.n = 1;
                break;
              }
              t = e.message, n = e.signature;
              _context188.n = 13;
              break;
            case 1:
              r = e.chain, i = e.wallet, a = e.statement, o = e.options;
              if (!V()) {
                _context188.n = 5;
                break;
              }
              if (!(typeof i == `object`)) {
                _context188.n = 2;
                break;
              }
              s = i;
              _context188.n = 4;
              break;
            case 2:
              _e42 = window;
              if (!(`ethereum` in _e42 && typeof _e42.ethereum == `object` && `request` in _e42.ethereum && typeof _e42.ethereum.request == `function`)) {
                _context188.n = 3;
                break;
              }
              s = _e42.ethereum;
              _context188.n = 4;
              break;
            case 3:
              throw Error(`@supabase/auth-js: No compatible Ethereum wallet interface on the window object (window.ethereum) detected. Make sure the user already has a wallet installed and connected for this app. Prefer passing the wallet interface object directly to signInWithWeb3({ chain: 'ethereum', wallet: resolvedUserWallet }) instead.`);
            case 4:
              _context188.n = 7;
              break;
            case 5:
              if (!(typeof i != `object` || !(o !== null && o !== void 0 && o.url))) {
                _context188.n = 6;
                break;
              }
              throw Error(`@supabase/auth-js: Both wallet and url must be specified in non-browser environments.`);
            case 6:
              s = i;
            case 7:
              c = new URL((_o$url = o === null || o === void 0 ? void 0 : o.url) !== null && _o$url !== void 0 ? _o$url : window.location.href);
              _context188.n = 8;
              return s.request({
                method: `eth_requestAccounts`
              }).then(e => e).catch(() => {
                throw Error(`@supabase/auth-js: Wallet method eth_requestAccounts is missing or invalid`);
              });
            case 8:
              _l3 = _context188.v;
              if (!(!_l3 || _l3.length === 0)) {
                _context188.n = 9;
                break;
              }
              throw Error(`@supabase/auth-js: No accounts available. Please ensure the wallet is connected.`);
            case 9:
              _u3 = Gr(_l3[0]), _d3 = o === null || o === void 0 || (_o$signInWithEthereum = o.signInWithEthereum) === null || _o$signInWithEthereum === void 0 ? void 0 : _o$signInWithEthereum.chainId;
              _t125 = _d3;
              if (_t125) {
                _context188.n = 11;
                break;
              }
              _t126 = Kr;
              _context188.n = 10;
              return s.request({
                method: `eth_chainId`
              });
            case 10:
              _d3 = _t126(_context188.v);
            case 11:
              t = Jr({
                domain: c.host,
                address: _u3,
                statement: a,
                uri: c.href,
                version: `1`,
                chainId: _d3,
                nonce: o === null || o === void 0 || (_o$signInWithEthereum2 = o.signInWithEthereum) === null || _o$signInWithEthereum2 === void 0 ? void 0 : _o$signInWithEthereum2.nonce,
                issuedAt: (_o$signInWithEthereum3 = o === null || o === void 0 || (_o$signInWithEthereum4 = o.signInWithEthereum) === null || _o$signInWithEthereum4 === void 0 ? void 0 : _o$signInWithEthereum4.issuedAt) !== null && _o$signInWithEthereum3 !== void 0 ? _o$signInWithEthereum3 : new Date(),
                expirationTime: o === null || o === void 0 || (_o$signInWithEthereum5 = o.signInWithEthereum) === null || _o$signInWithEthereum5 === void 0 ? void 0 : _o$signInWithEthereum5.expirationTime,
                notBefore: o === null || o === void 0 || (_o$signInWithEthereum6 = o.signInWithEthereum) === null || _o$signInWithEthereum6 === void 0 ? void 0 : _o$signInWithEthereum6.notBefore,
                requestId: o === null || o === void 0 || (_o$signInWithEthereum7 = o.signInWithEthereum) === null || _o$signInWithEthereum7 === void 0 ? void 0 : _o$signInWithEthereum7.requestId,
                resources: o === null || o === void 0 || (_o$signInWithEthereum8 = o.signInWithEthereum) === null || _o$signInWithEthereum8 === void 0 ? void 0 : _o$signInWithEthereum8.resources
              });
              _context188.n = 12;
              return s.request({
                method: `personal_sign`,
                params: [qr(t), _u3]
              });
            case 12:
              n = _context188.v;
            case 13:
              _context188.p = 13;
              _context188.n = 14;
              return Y(_this130.fetch, `POST`, `${_this130.url}/token?grant_type=web3`, {
                headers: _this130.headers,
                body: Object.assign({
                  chain: `ethereum`,
                  message: t,
                  signature: n
                }, (_e$options7 = e.options) !== null && _e$options7 !== void 0 && _e$options7.captchaToken ? {
                  gotrue_meta_security: {
                    captcha_token: (_e$options8 = e.options) === null || _e$options8 === void 0 ? void 0 : _e$options8.captchaToken
                  }
                } : null),
                xform: X
              });
            case 14:
              _yield$Y3 = _context188.v;
              _r13 = _yield$Y3.data;
              _i17 = _yield$Y3.error;
              if (!_i17) {
                _context188.n = 15;
                break;
              }
              throw _i17;
            case 15:
              if (!(!_r13 || !_r13.session || !_r13.user)) {
                _context188.n = 16;
                break;
              }
              _e43 = new R();
              return _context188.a(2, _this130._returnResult({
                data: {
                  user: null,
                  session: null
                },
                error: _e43
              }));
            case 16:
              _t127 = _r13.session;
              if (!_t127) {
                _context188.n = 18;
                break;
              }
              _context188.n = 17;
              return _this130._saveSession(_r13.session);
            case 17:
              _context188.n = 18;
              return _this130._notifyAllSubscribers(`SIGNED_IN`, _r13.session);
            case 18:
              return _context188.a(2, _this130._returnResult({
                data: Object.assign({}, _r13),
                error: _i17
              }));
            case 19:
              _context188.p = 19;
              _t128 = _context188.v;
              if (!P(_t128)) {
                _context188.n = 20;
                break;
              }
              return _context188.a(2, _this130._returnResult({
                data: {
                  user: null,
                  session: null
                },
                error: _t128
              }));
            case 20:
              throw _t128;
            case 21:
              return _context188.a(2);
          }
        }, _callee187, null, [[13, 19]]);
      }))();
    }
    signInWithSolana(e) {
      var _this131 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee188() {
        var t, n, _o$url2, r, i, a, o, s, _e44, c, _e45, _r14, _o$signInWithSolana$i, _o$signInWithSolana, _o$signInWithSolana2, _o$signInWithSolana3, _o$signInWithSolana4, _o$signInWithSolana5, _o$signInWithSolana6, _o$signInWithSolana7, _e46, _e$options9, _e$options0, _yield$Y4, _r15, _i18, _e47, _t129, _t130;
        return _regenerator().w(function (_context189) {
          while (1) switch (_context189.p = _context189.n) {
            case 0:
              if (!(`message` in e)) {
                _context189.n = 1;
                break;
              }
              t = e.message, n = e.signature;
              _context189.n = 18;
              break;
            case 1:
              r = e.chain, i = e.wallet, a = e.statement, o = e.options;
              if (!V()) {
                _context189.n = 5;
                break;
              }
              if (!(typeof i == `object`)) {
                _context189.n = 2;
                break;
              }
              s = i;
              _context189.n = 4;
              break;
            case 2:
              _e44 = window;
              if (!(`solana` in _e44 && typeof _e44.solana == `object` && (`signIn` in _e44.solana && typeof _e44.solana.signIn == `function` || `signMessage` in _e44.solana && typeof _e44.solana.signMessage == `function`))) {
                _context189.n = 3;
                break;
              }
              s = _e44.solana;
              _context189.n = 4;
              break;
            case 3:
              throw Error(`@supabase/auth-js: No compatible Solana wallet interface on the window object (window.solana) detected. Make sure the user already has a wallet installed and connected for this app. Prefer passing the wallet interface object directly to signInWithWeb3({ chain: 'solana', wallet: resolvedUserWallet }) instead.`);
            case 4:
              _context189.n = 7;
              break;
            case 5:
              if (!(typeof i != `object` || !(o !== null && o !== void 0 && o.url))) {
                _context189.n = 6;
                break;
              }
              throw Error(`@supabase/auth-js: Both wallet and url must be specified in non-browser environments.`);
            case 6:
              s = i;
            case 7:
              c = new URL((_o$url2 = o === null || o === void 0 ? void 0 : o.url) !== null && _o$url2 !== void 0 ? _o$url2 : window.location.href);
              if (!(`signIn` in s && s.signIn)) {
                _context189.n = 14;
                break;
              }
              _context189.n = 8;
              return s.signIn(Object.assign(Object.assign(Object.assign({
                issuedAt: new Date().toISOString()
              }, o === null || o === void 0 ? void 0 : o.signInWithSolana), {
                version: `1`,
                domain: c.host,
                uri: c.href
              }), a ? {
                statement: a
              } : null));
            case 8:
              _e45 = _context189.v;
              if (!(Array.isArray(_e45) && _e45[0] && typeof _e45[0] == `object`)) {
                _context189.n = 9;
                break;
              }
              _r14 = _e45[0];
              _context189.n = 11;
              break;
            case 9:
              if (!(_e45 && typeof _e45 == `object` && `signedMessage` in _e45 && `signature` in _e45)) {
                _context189.n = 10;
                break;
              }
              _r14 = _e45;
              _context189.n = 11;
              break;
            case 10:
              throw Error(`@supabase/auth-js: Wallet method signIn() returned unrecognized value`);
            case 11:
              if (!(`signedMessage` in _r14 && `signature` in _r14 && (typeof _r14.signedMessage == `string` || _r14.signedMessage instanceof Uint8Array) && _r14.signature instanceof Uint8Array)) {
                _context189.n = 12;
                break;
              }
              t = typeof _r14.signedMessage == `string` ? _r14.signedMessage : new TextDecoder().decode(_r14.signedMessage), n = _r14.signature;
              _context189.n = 13;
              break;
            case 12:
              throw Error(`@supabase/auth-js: Wallet method signIn() API returned object without signedMessage and signature fields`);
            case 13:
              _context189.n = 18;
              break;
            case 14:
              if (!(!(`signMessage` in s) || typeof s.signMessage != `function` || !(`publicKey` in s) || typeof s != `object` || !s.publicKey || !(`toBase58` in s.publicKey) || typeof s.publicKey.toBase58 != `function`)) {
                _context189.n = 15;
                break;
              }
              throw Error(`@supabase/auth-js: Wallet does not have a compatible signMessage() and publicKey.toBase58() API`);
            case 15:
              t = [`${c.host} wants you to sign in with your Solana account:`, s.publicKey.toBase58(), ...(a ? [``, a, ``] : [``]), `Version: 1`, `URI: ${c.href}`, `Issued At: ${(_o$signInWithSolana$i = o === null || o === void 0 || (_o$signInWithSolana = o.signInWithSolana) === null || _o$signInWithSolana === void 0 ? void 0 : _o$signInWithSolana.issuedAt) !== null && _o$signInWithSolana$i !== void 0 ? _o$signInWithSolana$i : new Date().toISOString()}`, ...(o !== null && o !== void 0 && (_o$signInWithSolana2 = o.signInWithSolana) !== null && _o$signInWithSolana2 !== void 0 && _o$signInWithSolana2.notBefore ? [`Not Before: ${o.signInWithSolana.notBefore}`] : []), ...(o !== null && o !== void 0 && (_o$signInWithSolana3 = o.signInWithSolana) !== null && _o$signInWithSolana3 !== void 0 && _o$signInWithSolana3.expirationTime ? [`Expiration Time: ${o.signInWithSolana.expirationTime}`] : []), ...(o !== null && o !== void 0 && (_o$signInWithSolana4 = o.signInWithSolana) !== null && _o$signInWithSolana4 !== void 0 && _o$signInWithSolana4.chainId ? [`Chain ID: ${o.signInWithSolana.chainId}`] : []), ...(o !== null && o !== void 0 && (_o$signInWithSolana5 = o.signInWithSolana) !== null && _o$signInWithSolana5 !== void 0 && _o$signInWithSolana5.nonce ? [`Nonce: ${o.signInWithSolana.nonce}`] : []), ...(o !== null && o !== void 0 && (_o$signInWithSolana6 = o.signInWithSolana) !== null && _o$signInWithSolana6 !== void 0 && _o$signInWithSolana6.requestId ? [`Request ID: ${o.signInWithSolana.requestId}`] : []), ...(o !== null && o !== void 0 && (_o$signInWithSolana7 = o.signInWithSolana) !== null && _o$signInWithSolana7 !== void 0 && (_o$signInWithSolana7 = _o$signInWithSolana7.resources) !== null && _o$signInWithSolana7 !== void 0 && _o$signInWithSolana7.length ? [`Resources`, ...o.signInWithSolana.resources.map(e => `- ${e}`)] : [])].join(`
`);
              _context189.n = 16;
              return s.signMessage(new TextEncoder().encode(t), `utf8`);
            case 16:
              _e46 = _context189.v;
              if (!(!_e46 || !(_e46 instanceof Uint8Array))) {
                _context189.n = 17;
                break;
              }
              throw Error(`@supabase/auth-js: Wallet signMessage() API returned an recognized value`);
            case 17:
              n = _e46;
            case 18:
              _context189.p = 18;
              _context189.n = 19;
              return Y(_this131.fetch, `POST`, `${_this131.url}/token?grant_type=web3`, {
                headers: _this131.headers,
                body: Object.assign({
                  chain: `solana`,
                  message: t,
                  signature: B(n)
                }, (_e$options9 = e.options) !== null && _e$options9 !== void 0 && _e$options9.captchaToken ? {
                  gotrue_meta_security: {
                    captcha_token: (_e$options0 = e.options) === null || _e$options0 === void 0 ? void 0 : _e$options0.captchaToken
                  }
                } : null),
                xform: X
              });
            case 19:
              _yield$Y4 = _context189.v;
              _r15 = _yield$Y4.data;
              _i18 = _yield$Y4.error;
              if (!_i18) {
                _context189.n = 20;
                break;
              }
              throw _i18;
            case 20:
              if (!(!_r15 || !_r15.session || !_r15.user)) {
                _context189.n = 21;
                break;
              }
              _e47 = new R();
              return _context189.a(2, _this131._returnResult({
                data: {
                  user: null,
                  session: null
                },
                error: _e47
              }));
            case 21:
              _t129 = _r15.session;
              if (!_t129) {
                _context189.n = 23;
                break;
              }
              _context189.n = 22;
              return _this131._saveSession(_r15.session);
            case 22:
              _context189.n = 23;
              return _this131._notifyAllSubscribers(`SIGNED_IN`, _r15.session);
            case 23:
              return _context189.a(2, _this131._returnResult({
                data: Object.assign({}, _r15),
                error: _i18
              }));
            case 24:
              _context189.p = 24;
              _t130 = _context189.v;
              if (!P(_t130)) {
                _context189.n = 25;
                break;
              }
              return _context189.a(2, _this131._returnResult({
                data: {
                  user: null,
                  session: null
                },
                error: _t130
              }));
            case 25:
              throw _t130;
            case 26:
              return _context189.a(2);
          }
        }, _callee188, null, [[18, 24]]);
      }))();
    }
    _exchangeCodeForSession(e) {
      var _this132 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee189() {
        var _yield$U;
        var _split, _split2, t, n, _yield$Y5, r, i, _e48, _t131, _t132, _t133, _t134, _t135;
        return _regenerator().w(function (_context190) {
          while (1) switch (_context190.p = _context190.n) {
            case 0:
              _context190.n = 1;
              return U(_this132.storage, `${_this132.storageKey}-code-verifier`);
            case 1:
              _t132 = _yield$U = _context190.v;
              _t131 = _t132 !== null;
              if (!_t131) {
                _context190.n = 2;
                break;
              }
              _t131 = _yield$U !== void 0;
            case 2:
              if (!_t131) {
                _context190.n = 3;
                break;
              }
              _t133 = _yield$U;
              _context190.n = 4;
              break;
            case 3:
              _t133 = ``;
            case 4:
              _split = _t133.split(`/`);
              _split2 = _slicedToArray(_split, 2);
              t = _split2[0];
              n = _split2[1];
              _context190.p = 5;
              if (!(!t && _this132.flowType === `pkce`)) {
                _context190.n = 6;
                break;
              }
              throw new Rn();
            case 6:
              _context190.n = 7;
              return Y(_this132.fetch, `POST`, `${_this132.url}/token?grant_type=pkce`, {
                headers: _this132.headers,
                body: {
                  auth_code: e,
                  code_verifier: t
                },
                xform: X
              });
            case 7:
              _yield$Y5 = _context190.v;
              r = _yield$Y5.data;
              i = _yield$Y5.error;
              _context190.n = 8;
              return W(_this132.storage, `${_this132.storageKey}-code-verifier`);
            case 8:
              if (!i) {
                _context190.n = 9;
                break;
              }
              throw i;
            case 9:
              if (!(!r || !r.session || !r.user)) {
                _context190.n = 10;
                break;
              }
              _e48 = new R();
              return _context190.a(2, _this132._returnResult({
                data: {
                  user: null,
                  session: null,
                  redirectType: null
                },
                error: _e48
              }));
            case 10:
              _t134 = r.session;
              if (!_t134) {
                _context190.n = 12;
                break;
              }
              _context190.n = 11;
              return _this132._saveSession(r.session);
            case 11:
              _context190.n = 12;
              return _this132._notifyAllSubscribers(n === `recovery` ? `PASSWORD_RECOVERY` : `SIGNED_IN`, r.session);
            case 12:
              return _context190.a(2, _this132._returnResult({
                data: Object.assign(Object.assign({}, r), {
                  redirectType: n !== null && n !== void 0 ? n : null
                }),
                error: i
              }));
            case 13:
              _context190.p = 13;
              _t135 = _context190.v;
              _context190.n = 14;
              return W(_this132.storage, `${_this132.storageKey}-code-verifier`);
            case 14:
              if (!P(_t135)) {
                _context190.n = 15;
                break;
              }
              return _context190.a(2, _this132._returnResult({
                data: {
                  user: null,
                  session: null,
                  redirectType: null
                },
                error: _t135
              }));
            case 15:
              throw _t135;
            case 16:
              return _context190.a(2);
          }
        }, _callee189, null, [[5, 13]]);
      }))();
    }
    signInWithIdToken(e) {
      var _this133 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee190() {
        var _t136, n, r, i, a, _yield$Y6, o, s, _e49, _t137, _t138;
        return _regenerator().w(function (_context191) {
          while (1) switch (_context191.p = _context191.n) {
            case 0:
              _context191.p = 0;
              _t136 = e.options;
              n = e.provider;
              r = e.token;
              i = e.access_token;
              a = e.nonce;
              _context191.n = 1;
              return Y(_this133.fetch, `POST`, `${_this133.url}/token?grant_type=id_token`, {
                headers: _this133.headers,
                body: {
                  provider: n,
                  id_token: r,
                  access_token: i,
                  nonce: a,
                  gotrue_meta_security: {
                    captcha_token: _t136 === null || _t136 === void 0 ? void 0 : _t136.captchaToken
                  }
                },
                xform: X
              });
            case 1:
              _yield$Y6 = _context191.v;
              o = _yield$Y6.data;
              s = _yield$Y6.error;
              if (!s) {
                _context191.n = 2;
                break;
              }
              return _context191.a(2, _this133._returnResult({
                data: {
                  user: null,
                  session: null
                },
                error: s
              }));
            case 2:
              if (!(!o || !o.session || !o.user)) {
                _context191.n = 3;
                break;
              }
              _e49 = new R();
              return _context191.a(2, _this133._returnResult({
                data: {
                  user: null,
                  session: null
                },
                error: _e49
              }));
            case 3:
              _t137 = o.session;
              if (!_t137) {
                _context191.n = 5;
                break;
              }
              _context191.n = 4;
              return _this133._saveSession(o.session);
            case 4:
              _context191.n = 5;
              return _this133._notifyAllSubscribers(`SIGNED_IN`, o.session);
            case 5:
              return _context191.a(2, _this133._returnResult({
                data: o,
                error: s
              }));
            case 6:
              _context191.p = 6;
              _t138 = _context191.v;
              if (!P(_t138)) {
                _context191.n = 7;
                break;
              }
              return _context191.a(2, _this133._returnResult({
                data: {
                  user: null,
                  session: null
                },
                error: _t138
              }));
            case 7:
              throw _t138;
            case 8:
              return _context191.a(2);
          }
        }, _callee190, null, [[0, 6]]);
      }))();
    }
    signInWithOtp(e) {
      var _this134 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee191() {
        var _yield$G3, _yield$G4, _n$data, _n$shouldCreateUser, _t139, n, r, i, _yield$Y7, a, _n19$data, _n19$shouldCreateUser, _n19$channel, _t140, _n19, _yield$Y8, _r16, _i19, _t141, _t142;
        return _regenerator().w(function (_context192) {
          while (1) switch (_context192.p = _context192.n) {
            case 0:
              _context192.p = 0;
              if (!(`email` in e)) {
                _context192.n = 4;
                break;
              }
              _t139 = e.email, n = e.options, r = null, i = null;
              _t141 = _this134.flowType === `pkce`;
              if (!_t141) {
                _context192.n = 2;
                break;
              }
              _context192.n = 1;
              return G(_this134.storage, _this134.storageKey);
            case 1:
              _yield$G3 = _context192.v;
              _yield$G4 = _slicedToArray(_yield$G3, 2);
              r = _yield$G4[0];
              i = _yield$G4[1];
              _yield$G3;
            case 2:
              _context192.n = 3;
              return Y(_this134.fetch, `POST`, `${_this134.url}/otp`, {
                headers: _this134.headers,
                body: {
                  email: _t139,
                  data: (_n$data = n === null || n === void 0 ? void 0 : n.data) !== null && _n$data !== void 0 ? _n$data : {},
                  create_user: (_n$shouldCreateUser = n === null || n === void 0 ? void 0 : n.shouldCreateUser) !== null && _n$shouldCreateUser !== void 0 ? _n$shouldCreateUser : !0,
                  gotrue_meta_security: {
                    captcha_token: n === null || n === void 0 ? void 0 : n.captchaToken
                  },
                  code_challenge: r,
                  code_challenge_method: i
                },
                redirectTo: n === null || n === void 0 ? void 0 : n.emailRedirectTo
              });
            case 3:
              _yield$Y7 = _context192.v;
              a = _yield$Y7.error;
              return _context192.a(2, _this134._returnResult({
                data: {
                  user: null,
                  session: null
                },
                error: a
              }));
            case 4:
              if (!(`phone` in e)) {
                _context192.n = 6;
                break;
              }
              _t140 = e.phone;
              _n19 = e.options;
              _context192.n = 5;
              return Y(_this134.fetch, `POST`, `${_this134.url}/otp`, {
                headers: _this134.headers,
                body: {
                  phone: _t140,
                  data: (_n19$data = _n19 === null || _n19 === void 0 ? void 0 : _n19.data) !== null && _n19$data !== void 0 ? _n19$data : {},
                  create_user: (_n19$shouldCreateUser = _n19 === null || _n19 === void 0 ? void 0 : _n19.shouldCreateUser) !== null && _n19$shouldCreateUser !== void 0 ? _n19$shouldCreateUser : !0,
                  gotrue_meta_security: {
                    captcha_token: _n19 === null || _n19 === void 0 ? void 0 : _n19.captchaToken
                  },
                  channel: (_n19$channel = _n19 === null || _n19 === void 0 ? void 0 : _n19.channel) !== null && _n19$channel !== void 0 ? _n19$channel : `sms`
                }
              });
            case 5:
              _yield$Y8 = _context192.v;
              _r16 = _yield$Y8.data;
              _i19 = _yield$Y8.error;
              return _context192.a(2, _this134._returnResult({
                data: {
                  user: null,
                  session: null,
                  messageId: _r16 === null || _r16 === void 0 ? void 0 : _r16.message_id
                },
                error: _i19
              }));
            case 6:
              throw new Pn(`You must provide either an email or phone number.`);
            case 7:
              _context192.p = 7;
              _t142 = _context192.v;
              _context192.n = 8;
              return W(_this134.storage, `${_this134.storageKey}-code-verifier`);
            case 8:
              if (!P(_t142)) {
                _context192.n = 9;
                break;
              }
              return _context192.a(2, _this134._returnResult({
                data: {
                  user: null,
                  session: null
                },
                error: _t142
              }));
            case 9:
              throw _t142;
            case 10:
              return _context192.a(2);
          }
        }, _callee191, null, [[0, 7]]);
      }))();
    }
    verifyOtp(e) {
      var _this135 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee192() {
        var _e$options1, _e$options10, _t143, n, _yield$Y9, r, i, a, o, _t144, _t145;
        return _regenerator().w(function (_context193) {
          while (1) switch (_context193.p = _context193.n) {
            case 0:
              _context193.p = 0;
              `options` in e && (_t143 = (_e$options1 = e.options) === null || _e$options1 === void 0 ? void 0 : _e$options1.redirectTo, n = (_e$options10 = e.options) === null || _e$options10 === void 0 ? void 0 : _e$options10.captchaToken);
              _context193.n = 1;
              return Y(_this135.fetch, `POST`, `${_this135.url}/verify`, {
                headers: _this135.headers,
                body: Object.assign(Object.assign({}, e), {
                  gotrue_meta_security: {
                    captcha_token: n
                  }
                }),
                redirectTo: _t143,
                xform: X
              });
            case 1:
              _yield$Y9 = _context193.v;
              r = _yield$Y9.data;
              i = _yield$Y9.error;
              if (!i) {
                _context193.n = 2;
                break;
              }
              throw i;
            case 2:
              if (r) {
                _context193.n = 3;
                break;
              }
              throw Error(`An error occurred on token verification.`);
            case 3:
              a = r.session, o = r.user;
              _t144 = a !== null && a !== void 0 && a.access_token;
              if (!_t144) {
                _context193.n = 5;
                break;
              }
              _context193.n = 4;
              return _this135._saveSession(a);
            case 4:
              _context193.n = 5;
              return _this135._notifyAllSubscribers(e.type == `recovery` ? `PASSWORD_RECOVERY` : `SIGNED_IN`, a);
            case 5:
              return _context193.a(2, _this135._returnResult({
                data: {
                  user: o,
                  session: a
                },
                error: null
              }));
            case 6:
              _context193.p = 6;
              _t145 = _context193.v;
              if (!P(_t145)) {
                _context193.n = 7;
                break;
              }
              return _context193.a(2, _this135._returnResult({
                data: {
                  user: null,
                  session: null
                },
                error: _t145
              }));
            case 7:
              throw _t145;
            case 8:
              return _context193.a(2);
          }
        }, _callee192, null, [[0, 6]]);
      }))();
    }
    signInWithSSO(e) {
      var _this136 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee193() {
        var _yield$G5, _yield$G6, _e$options$redirectTo, _e$options11, _e$options12, _r$data, _e$options13, _t146, n, r, _t147, _t148;
        return _regenerator().w(function (_context194) {
          while (1) switch (_context194.p = _context194.n) {
            case 0:
              _context194.p = 0;
              _t146 = null, n = null;
              _t147 = _this136.flowType === `pkce`;
              if (!_t147) {
                _context194.n = 2;
                break;
              }
              _context194.n = 1;
              return G(_this136.storage, _this136.storageKey);
            case 1:
              _yield$G5 = _context194.v;
              _yield$G6 = _slicedToArray(_yield$G5, 2);
              _t146 = _yield$G6[0];
              n = _yield$G6[1];
              _yield$G5;
            case 2:
              _context194.n = 3;
              return Y(_this136.fetch, `POST`, `${_this136.url}/sso`, {
                body: Object.assign(Object.assign(Object.assign(Object.assign(Object.assign({}, `providerId` in e ? {
                  provider_id: e.providerId
                } : null), `domain` in e ? {
                  domain: e.domain
                } : null), {
                  redirect_to: (_e$options$redirectTo = (_e$options11 = e.options) === null || _e$options11 === void 0 ? void 0 : _e$options11.redirectTo) !== null && _e$options$redirectTo !== void 0 ? _e$options$redirectTo : void 0
                }), e !== null && e !== void 0 && (_e$options12 = e.options) !== null && _e$options12 !== void 0 && _e$options12.captchaToken ? {
                  gotrue_meta_security: {
                    captcha_token: e.options.captchaToken
                  }
                } : null), {
                  skip_http_redirect: !0,
                  code_challenge: _t146,
                  code_challenge_method: n
                }),
                headers: _this136.headers,
                xform: jr
              });
            case 3:
              r = _context194.v;
              return _context194.a(2, ((_r$data = r.data) !== null && _r$data !== void 0 && _r$data.url && V() && !((_e$options13 = e.options) !== null && _e$options13 !== void 0 && _e$options13.skipBrowserRedirect) && window.location.assign(r.data.url), _this136._returnResult(r)));
            case 4:
              _context194.p = 4;
              _t148 = _context194.v;
              _context194.n = 5;
              return W(_this136.storage, `${_this136.storageKey}-code-verifier`);
            case 5:
              if (!P(_t148)) {
                _context194.n = 6;
                break;
              }
              return _context194.a(2, _this136._returnResult({
                data: null,
                error: _t148
              }));
            case 6:
              throw _t148;
            case 7:
              return _context194.a(2);
          }
        }, _callee193, null, [[0, 4]]);
      }))();
    }
    reauthenticate() {
      var _this137 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee195() {
        var _t149;
        return _regenerator().w(function (_context196) {
          while (1) switch (_context196.n) {
            case 0:
              _context196.n = 1;
              return _this137.initializePromise;
            case 1:
              if (!(_this137.lock == null)) {
                _context196.n = 3;
                break;
              }
              _context196.n = 2;
              return _this137._reauthenticate();
            case 2:
              _t149 = _context196.v;
              _context196.n = 5;
              break;
            case 3:
              _context196.n = 4;
              return _this137._acquireLock(_this137.lockAcquireTimeout, /*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee194() {
                return _regenerator().w(function (_context195) {
                  while (1) switch (_context195.n) {
                    case 0:
                      _context195.n = 1;
                      return _this137._reauthenticate();
                    case 1:
                      return _context195.a(2, _context195.v);
                  }
                }, _callee194);
              })));
            case 4:
              _t149 = _context196.v;
            case 5:
              return _context196.a(2, _t149);
          }
        }, _callee195);
      }))();
    }
    _reauthenticate() {
      var _this138 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee197() {
        var _t150;
        return _regenerator().w(function (_context198) {
          while (1) switch (_context198.p = _context198.n) {
            case 0:
              _context198.p = 0;
              _context198.n = 1;
              return _this138._useSession(/*#__PURE__*/function () {
                var _ref51 = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee196(e) {
                  var t, n, _yield$Y0, r;
                  return _regenerator().w(function (_context197) {
                    while (1) switch (_context197.n) {
                      case 0:
                        t = e.data.session, n = e.error;
                        if (!n) {
                          _context197.n = 1;
                          break;
                        }
                        throw n;
                      case 1:
                        if (t) {
                          _context197.n = 2;
                          break;
                        }
                        throw new L();
                      case 2:
                        _context197.n = 3;
                        return Y(_this138.fetch, `GET`, `${_this138.url}/reauthenticate`, {
                          headers: _this138.headers,
                          jwt: t.access_token
                        });
                      case 3:
                        _yield$Y0 = _context197.v;
                        r = _yield$Y0.error;
                        return _context197.a(2, _this138._returnResult({
                          data: {
                            user: null,
                            session: null
                          },
                          error: r
                        }));
                    }
                  }, _callee196);
                }));
                return function (_x89) {
                  return _ref51.apply(this, arguments);
                };
              }());
            case 1:
              return _context198.a(2, _context198.v);
            case 2:
              _context198.p = 2;
              _t150 = _context198.v;
              if (!P(_t150)) {
                _context198.n = 3;
                break;
              }
              return _context198.a(2, _this138._returnResult({
                data: {
                  user: null,
                  session: null
                },
                error: _t150
              }));
            case 3:
              throw _t150;
            case 4:
              return _context198.a(2);
          }
        }, _callee197, null, [[0, 2]]);
      }))();
    }
    resend(e) {
      var _this139 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee198() {
        var _t151, _yield$G7, _yield$G8, n, r, i, a, o, _yield$Y1, s, _n20, _r17, _i20, _yield$Y10, _a2, _o, _t152, _t153, _t154;
        return _regenerator().w(function (_context199) {
          while (1) switch (_context199.p = _context199.n) {
            case 0:
              _context199.p = 0;
              _t151 = `${_this139.url}/resend`;
              if (!(`email` in e)) {
                _context199.n = 5;
                break;
              }
              n = e.email, r = e.type, i = e.options, a = null, o = null;
              _t152 = _this139.flowType === `pkce`;
              if (!_t152) {
                _context199.n = 2;
                break;
              }
              _context199.n = 1;
              return G(_this139.storage, _this139.storageKey);
            case 1:
              _yield$G7 = _context199.v;
              _yield$G8 = _slicedToArray(_yield$G7, 2);
              a = _yield$G8[0];
              o = _yield$G8[1];
              _yield$G7;
            case 2:
              _context199.n = 3;
              return Y(_this139.fetch, `POST`, _t151, {
                headers: _this139.headers,
                body: {
                  email: n,
                  type: r,
                  gotrue_meta_security: {
                    captcha_token: i === null || i === void 0 ? void 0 : i.captchaToken
                  },
                  code_challenge: a,
                  code_challenge_method: o
                },
                redirectTo: i === null || i === void 0 ? void 0 : i.emailRedirectTo
              });
            case 3:
              _yield$Y1 = _context199.v;
              s = _yield$Y1.error;
              _t153 = s;
              if (!_t153) {
                _context199.n = 4;
                break;
              }
              _context199.n = 4;
              return W(_this139.storage, `${_this139.storageKey}-code-verifier`);
            case 4:
              return _context199.a(2, _this139._returnResult({
                data: {
                  user: null,
                  session: null
                },
                error: s
              }));
            case 5:
              if (!(`phone` in e)) {
                _context199.n = 7;
                break;
              }
              _n20 = e.phone;
              _r17 = e.type;
              _i20 = e.options;
              _context199.n = 6;
              return Y(_this139.fetch, `POST`, _t151, {
                headers: _this139.headers,
                body: {
                  phone: _n20,
                  type: _r17,
                  gotrue_meta_security: {
                    captcha_token: _i20 === null || _i20 === void 0 ? void 0 : _i20.captchaToken
                  }
                }
              });
            case 6:
              _yield$Y10 = _context199.v;
              _a2 = _yield$Y10.data;
              _o = _yield$Y10.error;
              return _context199.a(2, _this139._returnResult({
                data: {
                  user: null,
                  session: null,
                  messageId: _a2 === null || _a2 === void 0 ? void 0 : _a2.message_id
                },
                error: _o
              }));
            case 7:
              throw new Pn(`You must provide either an email or phone number and a type`);
            case 8:
              _context199.p = 8;
              _t154 = _context199.v;
              _context199.n = 9;
              return W(_this139.storage, `${_this139.storageKey}-code-verifier`);
            case 9:
              if (!P(_t154)) {
                _context199.n = 10;
                break;
              }
              return _context199.a(2, _this139._returnResult({
                data: {
                  user: null,
                  session: null
                },
                error: _t154
              }));
            case 10:
              throw _t154;
            case 11:
              return _context199.a(2);
          }
        }, _callee198, null, [[0, 8]]);
      }))();
    }
    getSession() {
      var _this140 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee202() {
        var _t155;
        return _regenerator().w(function (_context203) {
          while (1) switch (_context203.n) {
            case 0:
              _context203.n = 1;
              return _this140.initializePromise;
            case 1:
              if (!(_this140.lock == null)) {
                _context203.n = 3;
                break;
              }
              _context203.n = 2;
              return _this140._useSession(/*#__PURE__*/function () {
                var _ref52 = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee199(e) {
                  return _regenerator().w(function (_context200) {
                    while (1) switch (_context200.n) {
                      case 0:
                        return _context200.a(2, e);
                    }
                  }, _callee199);
                }));
                return function (_x90) {
                  return _ref52.apply(this, arguments);
                };
              }());
            case 2:
              _t155 = _context203.v;
              _context203.n = 5;
              break;
            case 3:
              _context203.n = 4;
              return _this140._acquireLock(_this140.lockAcquireTimeout, /*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee201() {
                return _regenerator().w(function (_context202) {
                  while (1) switch (_context202.n) {
                    case 0:
                      return _context202.a(2, _this140._useSession(/*#__PURE__*/function () {
                        var _ref54 = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee200(e) {
                          return _regenerator().w(function (_context201) {
                            while (1) switch (_context201.n) {
                              case 0:
                                return _context201.a(2, e);
                            }
                          }, _callee200);
                        }));
                        return function (_x91) {
                          return _ref54.apply(this, arguments);
                        };
                      }()));
                  }
                }, _callee201);
              })));
            case 4:
              _t155 = _context203.v;
            case 5:
              return _context203.a(2, _t155);
          }
        }, _callee202);
      }))();
    }
    _acquireLock(e, t) {
      var _this141 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee207() {
        var _e50, n;
        return _regenerator().w(function (_context208) {
          while (1) switch (_context208.p = _context208.n) {
            case 0:
              _this141._debug(`#_acquireLock`, `begin`, e);
              _context208.p = 1;
              if (!_this141.lockAcquired) {
                _context208.n = 2;
                break;
              }
              _e50 = _this141.pendingInLock.length ? _this141.pendingInLock[_this141.pendingInLock.length - 1] : Promise.resolve(), n = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee203() {
                return _regenerator().w(function (_context204) {
                  while (1) switch (_context204.n) {
                    case 0:
                      _context204.n = 1;
                      return _e50;
                    case 1:
                      _context204.n = 2;
                      return t();
                    case 2:
                      return _context204.a(2, _context204.v);
                  }
                }, _callee203);
              }))();
              return _context208.a(2, (_this141.pendingInLock.push(_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee204() {
                var _t156;
                return _regenerator().w(function (_context205) {
                  while (1) switch (_context205.p = _context205.n) {
                    case 0:
                      _context205.p = 0;
                      _context205.n = 1;
                      return n;
                    case 1:
                      _context205.n = 3;
                      break;
                    case 2:
                      _context205.p = 2;
                      _t156 = _context205.v;
                    case 3:
                      return _context205.a(2);
                  }
                }, _callee204, null, [[0, 2]]);
              }))()), n));
            case 2:
              _context208.n = 3;
              return _this141.lock(`lock:${_this141.storageKey}`, e, /*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee206() {
                var _e51, _e52;
                return _regenerator().w(function (_context207) {
                  while (1) switch (_context207.p = _context207.n) {
                    case 0:
                      _this141._debug(`#_acquireLock`, `lock acquired for storage key`, _this141.storageKey);
                      _context207.p = 1;
                      _this141.lockAcquired = !0;
                      _e51 = t();
                      _this141.pendingInLock.push(_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee205() {
                        var _t157;
                        return _regenerator().w(function (_context206) {
                          while (1) switch (_context206.p = _context206.n) {
                            case 0:
                              _context206.p = 0;
                              _context206.n = 1;
                              return _e51;
                            case 1:
                              _context206.n = 3;
                              break;
                            case 2:
                              _context206.p = 2;
                              _t157 = _context206.v;
                            case 3:
                              return _context206.a(2);
                          }
                        }, _callee205, null, [[0, 2]]);
                      }))());
                      _context207.n = 2;
                      return _e51;
                    case 2:
                      if (!_this141.pendingInLock.length) {
                        _context207.n = 5;
                        break;
                      }
                      _e52 = [..._this141.pendingInLock];
                      _context207.n = 3;
                      return Promise.all(_e52);
                    case 3:
                      _this141.pendingInLock.splice(0, _e52.length);
                    case 4:
                      _context207.n = 2;
                      break;
                    case 5:
                      _context207.n = 6;
                      return _e51;
                    case 6:
                      return _context207.a(2, _context207.v);
                    case 7:
                      _context207.p = 7;
                      _this141._debug(`#_acquireLock`, `lock released for storage key`, _this141.storageKey), _this141.lockAcquired = !1;
                      return _context207.f(7);
                    case 8:
                      return _context207.a(2);
                  }
                }, _callee206, null, [[1,, 7, 8]]);
              })));
            case 3:
              return _context208.a(2, _context208.v);
            case 4:
              _context208.p = 4;
              _this141._debug(`#_acquireLock`, `end`);
              return _context208.f(4);
            case 5:
              return _context208.a(2);
          }
        }, _callee207, null, [[1,, 4, 5]]);
      }))();
    }
    _useSession(e) {
      var _this142 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee208() {
        var _t158;
        return _regenerator().w(function (_context209) {
          while (1) switch (_context209.p = _context209.n) {
            case 0:
              _this142._debug(`#_useSession`, `begin`);
              _context209.p = 1;
              _t158 = e;
              _context209.n = 2;
              return _this142.__loadSession();
            case 2:
              _context209.n = 3;
              return _t158(_context209.v);
            case 3:
              return _context209.a(2, _context209.v);
            case 4:
              _context209.p = 4;
              _this142._debug(`#_useSession`, `end`);
              return _context209.f(4);
            case 5:
              return _context209.a(2);
          }
        }, _callee208, null, [[1,, 4, 5]]);
      }))();
    }
    __loadSession() {
      var _this143 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee209() {
        var _e53, _t159, n, _t160, _t161, _yield$_this143$_call, r, i, _t162, _t163;
        return _regenerator().w(function (_context210) {
          while (1) switch (_context210.p = _context210.n) {
            case 0:
              _this143._debug(`#__loadSession()`, `begin`), _this143.lock != null && !_this143.lockAcquired && _this143._debug(`#__loadSession()`, `used outside of an acquired lock!`, Error().stack);
              _context210.p = 1;
              _e53 = null;
              _context210.n = 2;
              return U(_this143.storage, _this143.storageKey);
            case 2:
              _t159 = _context210.v;
              _this143._debug(`#getSession()`, `session from storage`, _t159);
              _t163 = _t159 !== null;
              if (!_t163) {
                _context210.n = 4;
                break;
              }
              if (!_this143._isValidSession(_t159)) {
                _context210.n = 3;
                break;
              }
              _e53 = _t159;
              _context210.n = 4;
              break;
            case 3:
              _this143._debug(`#getSession()`, `session from storage is not valid`);
              _context210.n = 4;
              return _this143._removeSession();
            case 4:
              if (_e53) {
                _context210.n = 5;
                break;
              }
              return _context210.a(2, {
                data: {
                  session: null
                },
                error: null
              });
            case 5:
              n = _e53.expires_at ? _e53.expires_at * 1e3 - Date.now() < En : !1;
              if (!(_this143._debug(`#__loadSession()`, `session has${n ? `` : ` not`} expired`, `expires_at`, _e53.expires_at), !n)) {
                _context210.n = 8;
                break;
              }
              if (!_this143.userStorage) {
                _context210.n = 7;
                break;
              }
              _context210.n = 6;
              return U(_this143.userStorage, _this143.storageKey + `-user`);
            case 6:
              _t160 = _context210.v;
              _t160 !== null && _t160 !== void 0 && _t160.user ? _e53.user = _t160.user : _e53.user = Cr();
            case 7:
              if (_this143.storage.isServer && _e53.user && !_e53.user.__isUserNotAvailableProxy) {
                _t161 = {
                  value: _this143.suppressGetSessionWarning
                };
                _e53.user = wr(_e53.user, _t161), _t161.value && (_this143.suppressGetSessionWarning = !0);
              }
              return _context210.a(2, {
                data: {
                  session: _e53
                },
                error: null
              });
            case 8:
              _context210.n = 9;
              return _this143._callRefreshToken(_e53.refresh_token);
            case 9:
              _yield$_this143$_call = _context210.v;
              r = _yield$_this143$_call.data;
              i = _yield$_this143$_call.error;
              if (!i) {
                _context210.n = 12;
                break;
              }
              if (!(_e53.expires_at && _e53.expires_at * 1e3 > Date.now())) {
                _context210.n = 11;
                break;
              }
              _context210.n = 10;
              return U(_this143.storage, _this143.storageKey);
            case 10:
              _t162 = _context210.v;
              if (!(_t162 && _t162.refresh_token === _e53.refresh_token)) {
                _context210.n = 11;
                break;
              }
              return _context210.a(2, _this143._returnResult({
                data: {
                  session: _e53
                },
                error: null
              }));
            case 11:
              return _context210.a(2, _this143._returnResult({
                data: {
                  session: null
                },
                error: i
              }));
            case 12:
              return _context210.a(2, _this143._returnResult({
                data: {
                  session: r
                },
                error: null
              }));
            case 13:
              _context210.p = 13;
              _this143._debug(`#__loadSession()`, `end`);
              return _context210.f(13);
            case 14:
              return _context210.a(2);
          }
        }, _callee209, null, [[1,, 13, 14]]);
      }))();
    }
    getUser(e) {
      var _this144 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee211() {
        var t, _t164;
        return _regenerator().w(function (_context212) {
          while (1) switch (_context212.n) {
            case 0:
              if (!e) {
                _context212.n = 2;
                break;
              }
              _context212.n = 1;
              return _this144._getUser(e);
            case 1:
              return _context212.a(2, _context212.v);
            case 2:
              _context212.n = 3;
              return _this144.initializePromise;
            case 3:
              if (!(_this144.lock == null)) {
                _context212.n = 5;
                break;
              }
              _context212.n = 4;
              return _this144._getUser();
            case 4:
              _t164 = _context212.v;
              _context212.n = 7;
              break;
            case 5:
              _context212.n = 6;
              return _this144._acquireLock(_this144.lockAcquireTimeout, /*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee210() {
                return _regenerator().w(function (_context211) {
                  while (1) switch (_context211.n) {
                    case 0:
                      _context211.n = 1;
                      return _this144._getUser();
                    case 1:
                      return _context211.a(2, _context211.v);
                  }
                }, _callee210);
              })));
            case 6:
              _t164 = _context212.v;
            case 7:
              t = _t164;
              t.data.user && (_this144.suppressGetSessionWarning = !0);
              return _context212.a(2, t);
          }
        }, _callee211);
      }))();
    }
    _getUser(e) {
      var _this145 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee213() {
        var _t166, _t167, _t168;
        return _regenerator().w(function (_context214) {
          while (1) switch (_context214.p = _context214.n) {
            case 0:
              _context214.p = 0;
              if (!e) {
                _context214.n = 2;
                break;
              }
              _context214.n = 1;
              return Y(_this145.fetch, `GET`, `${_this145.url}/user`, {
                headers: _this145.headers,
                jwt: e,
                xform: Z
              });
            case 1:
              _t166 = _context214.v;
              _context214.n = 4;
              break;
            case 2:
              _context214.n = 3;
              return _this145._useSession(/*#__PURE__*/function () {
                var _ref60 = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee212(e) {
                  var _t$session, _t$session$access_tok, _t$session2;
                  var t, n, _t165;
                  return _regenerator().w(function (_context213) {
                    while (1) switch (_context213.n) {
                      case 0:
                        t = e.data, n = e.error;
                        if (!n) {
                          _context213.n = 1;
                          break;
                        }
                        throw n;
                      case 1:
                        if (!(!((_t$session = t.session) !== null && _t$session !== void 0 && _t$session.access_token) && !_this145.hasCustomAuthorizationHeader)) {
                          _context213.n = 2;
                          break;
                        }
                        _t165 = {
                          data: {
                            user: null
                          },
                          error: new L()
                        };
                        _context213.n = 4;
                        break;
                      case 2:
                        _context213.n = 3;
                        return Y(_this145.fetch, `GET`, `${_this145.url}/user`, {
                          headers: _this145.headers,
                          jwt: (_t$session$access_tok = (_t$session2 = t.session) === null || _t$session2 === void 0 ? void 0 : _t$session2.access_token) !== null && _t$session$access_tok !== void 0 ? _t$session$access_tok : void 0,
                          xform: Z
                        });
                      case 3:
                        _t165 = _context213.v;
                      case 4:
                        return _context213.a(2, _t165);
                    }
                  }, _callee212);
                }));
                return function (_x92) {
                  return _ref60.apply(this, arguments);
                };
              }());
            case 3:
              _t166 = _context214.v;
            case 4:
              return _context214.a(2, _t166);
            case 5:
              _context214.p = 5;
              _t167 = _context214.v;
              if (!P(_t167)) {
                _context214.n = 8;
                break;
              }
              _t168 = Nn(_t167);
              if (!_t168) {
                _context214.n = 7;
                break;
              }
              _context214.n = 6;
              return _this145._removeSession();
            case 6:
              _context214.n = 7;
              return W(_this145.storage, `${_this145.storageKey}-code-verifier`);
            case 7:
              return _context214.a(2, _this145._returnResult({
                data: {
                  user: null
                },
                error: _t167
              }));
            case 8:
              throw _t167;
            case 9:
              return _context214.a(2);
          }
        }, _callee213, null, [[0, 5]]);
      }))();
    }
    updateUser(_x93) {
      var _this146 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee215(e, t = {}) {
        var _t169;
        return _regenerator().w(function (_context216) {
          while (1) switch (_context216.n) {
            case 0:
              _context216.n = 1;
              return _this146.initializePromise;
            case 1:
              if (!(_this146.lock == null)) {
                _context216.n = 3;
                break;
              }
              _context216.n = 2;
              return _this146._updateUser(e, t);
            case 2:
              _t169 = _context216.v;
              _context216.n = 5;
              break;
            case 3:
              _context216.n = 4;
              return _this146._acquireLock(_this146.lockAcquireTimeout, /*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee214() {
                return _regenerator().w(function (_context215) {
                  while (1) switch (_context215.n) {
                    case 0:
                      _context215.n = 1;
                      return _this146._updateUser(e, t);
                    case 1:
                      return _context215.a(2, _context215.v);
                  }
                }, _callee214);
              })));
            case 4:
              _t169 = _context216.v;
            case 5:
              return _context216.a(2, _t169);
          }
        }, _callee215);
      })).apply(this, arguments);
    }
    _updateUser(_x94) {
      var _this147 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee217(e, t = {}) {
        var _t171;
        return _regenerator().w(function (_context218) {
          while (1) switch (_context218.p = _context218.n) {
            case 0:
              _context218.p = 0;
              _context218.n = 1;
              return _this147._useSession(/*#__PURE__*/function () {
                var _ref62 = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee216(n) {
                  var _yield$G9, _yield$G0;
                  var r, i, a, o, s, _yield$Y11, c, l, _t170;
                  return _regenerator().w(function (_context217) {
                    while (1) switch (_context217.n) {
                      case 0:
                        r = n.data, i = n.error;
                        if (!i) {
                          _context217.n = 1;
                          break;
                        }
                        throw i;
                      case 1:
                        if (r.session) {
                          _context217.n = 2;
                          break;
                        }
                        throw new L();
                      case 2:
                        a = r.session, o = null, s = null;
                        _t170 = _this147.flowType === `pkce` && e.email != null;
                        if (!_t170) {
                          _context217.n = 4;
                          break;
                        }
                        _context217.n = 3;
                        return G(_this147.storage, _this147.storageKey);
                      case 3:
                        _yield$G9 = _context217.v;
                        _yield$G0 = _slicedToArray(_yield$G9, 2);
                        o = _yield$G0[0];
                        s = _yield$G0[1];
                        _yield$G9;
                      case 4:
                        _context217.n = 5;
                        return Y(_this147.fetch, `PUT`, `${_this147.url}/user`, {
                          headers: _this147.headers,
                          redirectTo: t === null || t === void 0 ? void 0 : t.emailRedirectTo,
                          body: Object.assign(Object.assign({}, e), {
                            code_challenge: o,
                            code_challenge_method: s
                          }),
                          jwt: a.access_token,
                          xform: Z
                        });
                      case 5:
                        _yield$Y11 = _context217.v;
                        c = _yield$Y11.data;
                        l = _yield$Y11.error;
                        if (!l) {
                          _context217.n = 6;
                          break;
                        }
                        throw l;
                      case 6:
                        a.user = c.user;
                        _context217.n = 7;
                        return _this147._saveSession(a);
                      case 7:
                        _context217.n = 8;
                        return _this147._notifyAllSubscribers(`USER_UPDATED`, a);
                      case 8:
                        return _context217.a(2, _this147._returnResult({
                          data: {
                            user: a.user
                          },
                          error: null
                        }));
                    }
                  }, _callee216);
                }));
                return function (_x95) {
                  return _ref62.apply(this, arguments);
                };
              }());
            case 1:
              return _context218.a(2, _context218.v);
            case 2:
              _context218.p = 2;
              _t171 = _context218.v;
              _context218.n = 3;
              return W(_this147.storage, `${_this147.storageKey}-code-verifier`);
            case 3:
              if (!P(_t171)) {
                _context218.n = 4;
                break;
              }
              return _context218.a(2, _this147._returnResult({
                data: {
                  user: null
                },
                error: _t171
              }));
            case 4:
              throw _t171;
            case 5:
              return _context218.a(2);
          }
        }, _callee217, null, [[0, 2]]);
      })).apply(this, arguments);
    }
    setSession(e) {
      var _this148 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee219() {
        var _t172;
        return _regenerator().w(function (_context220) {
          while (1) switch (_context220.n) {
            case 0:
              _context220.n = 1;
              return _this148.initializePromise;
            case 1:
              if (!(_this148.lock == null)) {
                _context220.n = 3;
                break;
              }
              _context220.n = 2;
              return _this148._setSession(e);
            case 2:
              _t172 = _context220.v;
              _context220.n = 5;
              break;
            case 3:
              _context220.n = 4;
              return _this148._acquireLock(_this148.lockAcquireTimeout, /*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee218() {
                return _regenerator().w(function (_context219) {
                  while (1) switch (_context219.n) {
                    case 0:
                      _context219.n = 1;
                      return _this148._setSession(e);
                    case 1:
                      return _context219.a(2, _context219.v);
                  }
                }, _callee218);
              })));
            case 4:
              _t172 = _context220.v;
            case 5:
              return _context220.a(2, _t172);
          }
        }, _callee219);
      }))();
    }
    _setSession(e) {
      var _this149 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee220() {
        var _t173, n, r, i, _dr, a, _yield$_this149$_call, _t174, _n21, _yield$_this149$_getU, _r18, _a3, _t175;
        return _regenerator().w(function (_context221) {
          while (1) switch (_context221.p = _context221.n) {
            case 0:
              _context221.p = 0;
              if (!(!e.access_token || !e.refresh_token)) {
                _context221.n = 1;
                break;
              }
              throw new L();
            case 1:
              _t173 = Date.now() / 1e3, n = _t173, r = !0, i = null, _dr = dr(e.access_token), a = _dr.payload;
              if (!(a.exp && (n = a.exp, r = n <= _t173), r)) {
                _context221.n = 5;
                break;
              }
              _context221.n = 2;
              return _this149._callRefreshToken(e.refresh_token);
            case 2:
              _yield$_this149$_call = _context221.v;
              _t174 = _yield$_this149$_call.data;
              _n21 = _yield$_this149$_call.error;
              if (!_n21) {
                _context221.n = 3;
                break;
              }
              return _context221.a(2, _this149._returnResult({
                data: {
                  user: null,
                  session: null
                },
                error: _n21
              }));
            case 3:
              if (_t174) {
                _context221.n = 4;
                break;
              }
              return _context221.a(2, {
                data: {
                  user: null,
                  session: null
                },
                error: null
              });
            case 4:
              i = _t174;
              _context221.n = 9;
              break;
            case 5:
              _context221.n = 6;
              return _this149._getUser(e.access_token);
            case 6:
              _yield$_this149$_getU = _context221.v;
              _r18 = _yield$_this149$_getU.data;
              _a3 = _yield$_this149$_getU.error;
              if (!_a3) {
                _context221.n = 7;
                break;
              }
              return _context221.a(2, _this149._returnResult({
                data: {
                  user: null,
                  session: null
                },
                error: _a3
              }));
            case 7:
              i = {
                access_token: e.access_token,
                refresh_token: e.refresh_token,
                user: _r18.user,
                token_type: `bearer`,
                expires_in: n - _t173,
                expires_at: n
              };
              _context221.n = 8;
              return _this149._saveSession(i);
            case 8:
              _context221.n = 9;
              return _this149._notifyAllSubscribers(`SIGNED_IN`, i);
            case 9:
              return _context221.a(2, _this149._returnResult({
                data: {
                  user: i.user,
                  session: i
                },
                error: null
              }));
            case 10:
              _context221.p = 10;
              _t175 = _context221.v;
              if (!P(_t175)) {
                _context221.n = 11;
                break;
              }
              return _context221.a(2, _this149._returnResult({
                data: {
                  session: null,
                  user: null
                },
                error: _t175
              }));
            case 11:
              throw _t175;
            case 12:
              return _context221.a(2);
          }
        }, _callee220, null, [[0, 10]]);
      }))();
    }
    refreshSession(e) {
      var _this150 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee222() {
        var _t176;
        return _regenerator().w(function (_context223) {
          while (1) switch (_context223.n) {
            case 0:
              _context223.n = 1;
              return _this150.initializePromise;
            case 1:
              if (!(_this150.lock == null)) {
                _context223.n = 3;
                break;
              }
              _context223.n = 2;
              return _this150._refreshSession(e);
            case 2:
              _t176 = _context223.v;
              _context223.n = 5;
              break;
            case 3:
              _context223.n = 4;
              return _this150._acquireLock(_this150.lockAcquireTimeout, /*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee221() {
                return _regenerator().w(function (_context222) {
                  while (1) switch (_context222.n) {
                    case 0:
                      _context222.n = 1;
                      return _this150._refreshSession(e);
                    case 1:
                      return _context222.a(2, _context222.v);
                  }
                }, _callee221);
              })));
            case 4:
              _t176 = _context223.v;
            case 5:
              return _context223.a(2, _t176);
          }
        }, _callee222);
      }))();
    }
    _refreshSession(e) {
      var _this151 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee224() {
        var _t177;
        return _regenerator().w(function (_context225) {
          while (1) switch (_context225.p = _context225.n) {
            case 0:
              _context225.p = 0;
              _context225.n = 1;
              return _this151._useSession(/*#__PURE__*/function () {
                var _ref65 = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee223(t) {
                  var _e54;
                  var _n22$session, _n22, _r19, _yield$_this151$_call, n, r;
                  return _regenerator().w(function (_context224) {
                    while (1) switch (_context224.n) {
                      case 0:
                        if (e) {
                          _context224.n = 2;
                          break;
                        }
                        _n22 = t.data, _r19 = t.error;
                        if (!_r19) {
                          _context224.n = 1;
                          break;
                        }
                        throw _r19;
                      case 1:
                        e = (_n22$session = _n22.session) !== null && _n22$session !== void 0 ? _n22$session : void 0;
                      case 2:
                        if ((_e54 = e) !== null && _e54 !== void 0 && _e54.refresh_token) {
                          _context224.n = 3;
                          break;
                        }
                        throw new L();
                      case 3:
                        _context224.n = 4;
                        return _this151._callRefreshToken(e.refresh_token);
                      case 4:
                        _yield$_this151$_call = _context224.v;
                        n = _yield$_this151$_call.data;
                        r = _yield$_this151$_call.error;
                        return _context224.a(2, r ? _this151._returnResult({
                          data: {
                            user: null,
                            session: null
                          },
                          error: r
                        }) : n ? _this151._returnResult({
                          data: {
                            user: n.user,
                            session: n
                          },
                          error: null
                        }) : _this151._returnResult({
                          data: {
                            user: null,
                            session: null
                          },
                          error: null
                        }));
                    }
                  }, _callee223);
                }));
                return function (_x96) {
                  return _ref65.apply(this, arguments);
                };
              }());
            case 1:
              return _context225.a(2, _context225.v);
            case 2:
              _context225.p = 2;
              _t177 = _context225.v;
              if (!P(_t177)) {
                _context225.n = 3;
                break;
              }
              return _context225.a(2, _this151._returnResult({
                data: {
                  user: null,
                  session: null
                },
                error: _t177
              }));
            case 3:
              throw _t177;
            case 4:
              return _context225.a(2);
          }
        }, _callee224, null, [[0, 2]]);
      }))();
    }
    _getSessionFromURL(e, t) {
      var _this152 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee225() {
        var _t178$redirectType, _yield$_this152$_exch, _t178, _n23, _r20, n, r, i, a, o, s, c, _l4, _u4, _d4, _f2, _p2, _yield$_this152$_getU, _m2, _h2, _ee2, _t179, _t180;
        return _regenerator().w(function (_context226) {
          while (1) switch (_context226.p = _context226.n) {
            case 0:
              _context226.p = 0;
              if (V()) {
                _context226.n = 1;
                break;
              }
              throw new Fn(`No browser detected.`);
            case 1:
              if (!(e.error || e.error_description || e.error_code)) {
                _context226.n = 2;
                break;
              }
              throw new Fn(e.error_description || `Error in URL with unspecified error_description`, {
                error: e.error || `unspecified_error`,
                code: e.error_code || `unspecified_code`
              });
            case 2:
              _t179 = t;
              _context226.n = _t179 === `implicit` ? 3 : _t179 === `pkce` ? 5 : 7;
              break;
            case 3:
              if (!(_this152.flowType === `pkce`)) {
                _context226.n = 4;
                break;
              }
              throw new Ln(`Not a valid PKCE flow url.`);
            case 4:
              return _context226.a(3, 7);
            case 5:
              if (!(_this152.flowType === `implicit`)) {
                _context226.n = 6;
                break;
              }
              throw new Fn(`Not a valid implicit grant flow url.`);
            case 6:
              return _context226.a(3, 7);
            case 7:
              if (!(t === `pkce`)) {
                _context226.n = 11;
                break;
              }
              if (!(_this152._debug(`#_initialize()`, `begin`, `is PKCE flow`, !0), !e.code)) {
                _context226.n = 8;
                break;
              }
              throw new Ln(`No code detected.`);
            case 8:
              _context226.n = 9;
              return _this152._exchangeCodeForSession(e.code);
            case 9:
              _yield$_this152$_exch = _context226.v;
              _t178 = _yield$_this152$_exch.data;
              _n23 = _yield$_this152$_exch.error;
              if (!_n23) {
                _context226.n = 10;
                break;
              }
              throw _n23;
            case 10:
              _r20 = new URL(window.location.href);
              return _context226.a(2, (_r20.searchParams.delete(`code`), window.history.replaceState(window.history.state, ``, _r20.toString()), {
                data: {
                  session: _t178.session,
                  redirectType: (_t178$redirectType = _t178.redirectType) !== null && _t178$redirectType !== void 0 ? _t178$redirectType : null
                },
                error: null
              }));
            case 11:
              n = e.provider_token, r = e.provider_refresh_token, i = e.access_token, a = e.refresh_token, o = e.expires_in, s = e.expires_at, c = e.token_type;
              if (!(!i || !o || !a || !c)) {
                _context226.n = 12;
                break;
              }
              throw new Fn(`No session defined in URL`);
            case 12:
              _l4 = Math.round(Date.now() / 1e3), _u4 = parseInt(o), _d4 = _l4 + _u4;
              s && (_d4 = parseInt(s));
              _f2 = _d4 - _l4;
              _f2 * 1e3 <= M && console.warn(`@supabase/gotrue-js: Session as retrieved from URL expires in ${_f2}s, should have been closer to ${_u4}s`);
              _p2 = _d4 - _u4;
              _l4 - _p2 >= 120 ? console.warn(`@supabase/gotrue-js: Session as retrieved from URL was issued over 120s ago, URL could be stale`, _p2, _d4, _l4) : _l4 - _p2 < 0 && console.warn(`@supabase/gotrue-js: Session as retrieved from URL was issued in the future? Check the device clock for skew`, _p2, _d4, _l4);
              _context226.n = 13;
              return _this152._getUser(i);
            case 13:
              _yield$_this152$_getU = _context226.v;
              _m2 = _yield$_this152$_getU.data;
              _h2 = _yield$_this152$_getU.error;
              if (!_h2) {
                _context226.n = 14;
                break;
              }
              throw _h2;
            case 14:
              _ee2 = {
                provider_token: n,
                provider_refresh_token: r,
                access_token: i,
                expires_in: _u4,
                expires_at: _d4,
                refresh_token: a,
                token_type: c,
                user: _m2.user
              };
              return _context226.a(2, (window.location.hash = ``, _this152._debug(`#_getSessionFromURL()`, `clearing window.location.hash`), _this152._returnResult({
                data: {
                  session: _ee2,
                  redirectType: e.type
                },
                error: null
              })));
            case 15:
              _context226.p = 15;
              _t180 = _context226.v;
              if (!P(_t180)) {
                _context226.n = 16;
                break;
              }
              return _context226.a(2, _this152._returnResult({
                data: {
                  session: null,
                  redirectType: null
                },
                error: _t180
              }));
            case 16:
              throw _t180;
            case 17:
              return _context226.a(2);
          }
        }, _callee225, null, [[0, 15]]);
      }))();
    }
    _isImplicitGrantCallback(e) {
      return typeof this.detectSessionInUrl == `function` ? this.detectSessionInUrl(new URL(window.location.href), e) : !!(e.access_token || e.error || e.error_description || e.error_code);
    }
    _isPKCECallback(e) {
      var _this153 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee226() {
        var t;
        return _regenerator().w(function (_context227) {
          while (1) switch (_context227.n) {
            case 0:
              _context227.n = 1;
              return U(_this153.storage, `${_this153.storageKey}-code-verifier`);
            case 1:
              t = _context227.v;
              return _context227.a(2, !!(e.code && t));
          }
        }, _callee226);
      }))();
    }
    signOut() {
      var _this154 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee228(e = {
        scope: `global`
      }) {
        var _t181;
        return _regenerator().w(function (_context229) {
          while (1) switch (_context229.n) {
            case 0:
              _context229.n = 1;
              return _this154.initializePromise;
            case 1:
              if (!(_this154.lock == null)) {
                _context229.n = 3;
                break;
              }
              _context229.n = 2;
              return _this154._signOut(e);
            case 2:
              _t181 = _context229.v;
              _context229.n = 5;
              break;
            case 3:
              _context229.n = 4;
              return _this154._acquireLock(_this154.lockAcquireTimeout, /*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee227() {
                return _regenerator().w(function (_context228) {
                  while (1) switch (_context228.n) {
                    case 0:
                      _context228.n = 1;
                      return _this154._signOut(e);
                    case 1:
                      return _context228.a(2, _context228.v);
                  }
                }, _callee227);
              })));
            case 4:
              _t181 = _context229.v;
            case 5:
              return _context229.a(2, _t181);
          }
        }, _callee228);
      })).apply(this, arguments);
    }
    _signOut() {
      var _this155 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee230({
        scope: e
      } = {
        scope: `global`
      }) {
        return _regenerator().w(function (_context231) {
          while (1) switch (_context231.n) {
            case 0:
              _context231.n = 1;
              return _this155._useSession(/*#__PURE__*/function () {
                var _ref67 = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee229(t) {
                  var _n$session;
                  var n, r, i, _yield$_this155$admin, _t182, _t183;
                  return _regenerator().w(function (_context230) {
                    while (1) switch (_context230.n) {
                      case 0:
                        n = t.data, r = t.error;
                        if (!(r && !Nn(r))) {
                          _context230.n = 1;
                          break;
                        }
                        return _context230.a(2, _this155._returnResult({
                          error: r
                        }));
                      case 1:
                        i = (_n$session = n.session) === null || _n$session === void 0 ? void 0 : _n$session.access_token;
                        if (!i) {
                          _context230.n = 3;
                          break;
                        }
                        _context230.n = 2;
                        return _this155.admin.signOut(i, e);
                      case 2:
                        _yield$_this155$admin = _context230.v;
                        _t182 = _yield$_this155$admin.error;
                        if (!(_t182 && !(Mn(_t182) && (_t182.status === 404 || _t182.status === 401 || _t182.status === 403) || Nn(_t182)))) {
                          _context230.n = 3;
                          break;
                        }
                        return _context230.a(2, _this155._returnResult({
                          error: _t182
                        }));
                      case 3:
                        _t183 = e !== `others`;
                        if (!_t183) {
                          _context230.n = 5;
                          break;
                        }
                        _context230.n = 4;
                        return _this155._removeSession();
                      case 4:
                        _context230.n = 5;
                        return W(_this155.storage, `${_this155.storageKey}-code-verifier`);
                      case 5:
                        return _context230.a(2, _this155._returnResult({
                          error: null
                        }));
                    }
                  }, _callee229);
                }));
                return function (_x97) {
                  return _ref67.apply(this, arguments);
                };
              }());
            case 1:
              return _context231.a(2, _context231.v);
          }
        }, _callee230);
      })).apply(this, arguments);
    }
    onAuthStateChange(e) {
      var _this156 = this;
      var t = ir(),
        n = {
          id: t,
          callback: e,
          unsubscribe: () => {
            this._debug(`#unsubscribe()`, `state change callback with id removed`, t), this.stateChangeEmitters.delete(t);
          }
        };
      return this._debug(`#onAuthStateChange()`, `registered callback with id`, t), this.stateChangeEmitters.set(t, n), _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee232() {
        return _regenerator().w(function (_context233) {
          while (1) switch (_context233.n) {
            case 0:
              _context233.n = 1;
              return _this156.initializePromise;
            case 1:
              if (!(_this156.lock == null)) {
                _context233.n = 3;
                break;
              }
              _context233.n = 2;
              return _this156._emitInitialSession(t);
            case 2:
              _context233.n = 4;
              break;
            case 3:
              _context233.n = 4;
              return _this156._acquireLock(_this156.lockAcquireTimeout, /*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee231() {
                return _regenerator().w(function (_context232) {
                  while (1) switch (_context232.n) {
                    case 0:
                      _this156._emitInitialSession(t);
                    case 1:
                      return _context232.a(2);
                  }
                }, _callee231);
              })));
            case 4:
              return _context233.a(2);
          }
        }, _callee232);
      }))(), {
        data: {
          subscription: n
        }
      };
    }
    _emitInitialSession(e) {
      var _this157 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee234() {
        return _regenerator().w(function (_context235) {
          while (1) switch (_context235.n) {
            case 0:
              _context235.n = 1;
              return _this157._useSession(/*#__PURE__*/function () {
                var _ref70 = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee233(t) {
                  var _this157$stateChangeE, n, r, _this157$stateChangeE2, _t184;
                  return _regenerator().w(function (_context234) {
                    while (1) switch (_context234.p = _context234.n) {
                      case 0:
                        _context234.p = 0;
                        n = t.data.session, r = t.error;
                        if (!r) {
                          _context234.n = 1;
                          break;
                        }
                        throw r;
                      case 1:
                        _context234.n = 2;
                        return (_this157$stateChangeE = _this157.stateChangeEmitters.get(e)) === null || _this157$stateChangeE === void 0 ? void 0 : _this157$stateChangeE.callback(`INITIAL_SESSION`, n);
                      case 2:
                        _this157._debug(`INITIAL_SESSION`, `callback id`, e, `session`, n);
                        _context234.n = 5;
                        break;
                      case 3:
                        _context234.p = 3;
                        _t184 = _context234.v;
                        _context234.n = 4;
                        return (_this157$stateChangeE2 = _this157.stateChangeEmitters.get(e)) === null || _this157$stateChangeE2 === void 0 ? void 0 : _this157$stateChangeE2.callback(`INITIAL_SESSION`, null);
                      case 4:
                        _this157._debug(`INITIAL_SESSION`, `callback id`, e, `error`, _t184);
                        Nn(_t184) ? console.warn(_t184) : console.error(_t184);
                      case 5:
                        return _context234.a(2);
                    }
                  }, _callee233, null, [[0, 3]]);
                }));
                return function (_x98) {
                  return _ref70.apply(this, arguments);
                };
              }());
            case 1:
              return _context235.a(2, _context235.v);
          }
        }, _callee234);
      }))();
    }
    resetPasswordForEmail(_x99) {
      var _this158 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee235(e, t = {}) {
        var _yield$G1, _yield$G10;
        var n, r, _t185, _t186;
        return _regenerator().w(function (_context236) {
          while (1) switch (_context236.p = _context236.n) {
            case 0:
              n = null, r = null;
              _t185 = _this158.flowType === `pkce`;
              if (!_t185) {
                _context236.n = 2;
                break;
              }
              _context236.n = 1;
              return G(_this158.storage, _this158.storageKey, !0);
            case 1:
              _yield$G1 = _context236.v;
              _yield$G10 = _slicedToArray(_yield$G1, 2);
              n = _yield$G10[0];
              r = _yield$G10[1];
              _yield$G1;
            case 2:
              _context236.p = 2;
              _context236.n = 3;
              return Y(_this158.fetch, `POST`, `${_this158.url}/recover`, {
                body: {
                  email: e,
                  code_challenge: n,
                  code_challenge_method: r,
                  gotrue_meta_security: {
                    captcha_token: t.captchaToken
                  }
                },
                headers: _this158.headers,
                redirectTo: t.redirectTo
              });
            case 3:
              return _context236.a(2, _context236.v);
            case 4:
              _context236.p = 4;
              _t186 = _context236.v;
              _context236.n = 5;
              return W(_this158.storage, `${_this158.storageKey}-code-verifier`);
            case 5:
              if (!P(_t186)) {
                _context236.n = 6;
                break;
              }
              return _context236.a(2, _this158._returnResult({
                data: null,
                error: _t186
              }));
            case 6:
              throw _t186;
            case 7:
              return _context236.a(2);
          }
        }, _callee235, null, [[2, 4]]);
      })).apply(this, arguments);
    }
    getUserIdentities() {
      var _this159 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee236() {
        var _e55$user$identities, _yield$_this159$getUs, _e55, _t187, _t188;
        return _regenerator().w(function (_context237) {
          while (1) switch (_context237.p = _context237.n) {
            case 0:
              _context237.p = 0;
              _context237.n = 1;
              return _this159.getUser();
            case 1:
              _yield$_this159$getUs = _context237.v;
              _e55 = _yield$_this159$getUs.data;
              _t187 = _yield$_this159$getUs.error;
              if (!_t187) {
                _context237.n = 2;
                break;
              }
              throw _t187;
            case 2:
              return _context237.a(2, _this159._returnResult({
                data: {
                  identities: (_e55$user$identities = _e55.user.identities) !== null && _e55$user$identities !== void 0 ? _e55$user$identities : []
                },
                error: null
              }));
            case 3:
              _context237.p = 3;
              _t188 = _context237.v;
              if (!P(_t188)) {
                _context237.n = 4;
                break;
              }
              return _context237.a(2, _this159._returnResult({
                data: null,
                error: _t188
              }));
            case 4:
              throw _t188;
            case 5:
              return _context237.a(2);
          }
        }, _callee236, null, [[0, 3]]);
      }))();
    }
    linkIdentity(e) {
      var _this160 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee237() {
        return _regenerator().w(function (_context238) {
          while (1) switch (_context238.n) {
            case 0:
              return _context238.a(2, `token` in e ? _this160.linkIdentityIdToken(e) : _this160.linkIdentityOAuth(e));
          }
        }, _callee237);
      }))();
    }
    linkIdentityOAuth(e) {
      var _this161 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee239() {
        var _e$options17, _yield$_this161$_useS, _t189, n, _t190;
        return _regenerator().w(function (_context240) {
          while (1) switch (_context240.p = _context240.n) {
            case 0:
              _context240.p = 0;
              _context240.n = 1;
              return _this161._useSession(/*#__PURE__*/function () {
                var _ref71 = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee238(t) {
                  var _e$options14, _e$options15, _e$options16, _n$session$access_tok, _n$session2;
                  var n, r, i;
                  return _regenerator().w(function (_context239) {
                    while (1) switch (_context239.n) {
                      case 0:
                        n = t.data, r = t.error;
                        if (!r) {
                          _context239.n = 1;
                          break;
                        }
                        throw r;
                      case 1:
                        _context239.n = 2;
                        return _this161._getUrlForProvider(`${_this161.url}/user/identities/authorize`, e.provider, {
                          redirectTo: (_e$options14 = e.options) === null || _e$options14 === void 0 ? void 0 : _e$options14.redirectTo,
                          scopes: (_e$options15 = e.options) === null || _e$options15 === void 0 ? void 0 : _e$options15.scopes,
                          queryParams: (_e$options16 = e.options) === null || _e$options16 === void 0 ? void 0 : _e$options16.queryParams,
                          skipBrowserRedirect: !0
                        });
                      case 2:
                        i = _context239.v;
                        _context239.n = 3;
                        return Y(_this161.fetch, `GET`, i, {
                          headers: _this161.headers,
                          jwt: (_n$session$access_tok = (_n$session2 = n.session) === null || _n$session2 === void 0 ? void 0 : _n$session2.access_token) !== null && _n$session$access_tok !== void 0 ? _n$session$access_tok : void 0
                        });
                      case 3:
                        return _context239.a(2, _context239.v);
                    }
                  }, _callee238);
                }));
                return function (_x100) {
                  return _ref71.apply(this, arguments);
                };
              }());
            case 1:
              _yield$_this161$_useS = _context240.v;
              _t189 = _yield$_this161$_useS.data;
              n = _yield$_this161$_useS.error;
              if (!n) {
                _context240.n = 2;
                break;
              }
              throw n;
            case 2:
              return _context240.a(2, (V() && !((_e$options17 = e.options) !== null && _e$options17 !== void 0 && _e$options17.skipBrowserRedirect) && window.location.assign(_t189 === null || _t189 === void 0 ? void 0 : _t189.url), _this161._returnResult({
                data: {
                  provider: e.provider,
                  url: _t189 === null || _t189 === void 0 ? void 0 : _t189.url
                },
                error: null
              })));
            case 3:
              _context240.p = 3;
              _t190 = _context240.v;
              if (!P(_t190)) {
                _context240.n = 4;
                break;
              }
              return _context240.a(2, _this161._returnResult({
                data: {
                  provider: e.provider,
                  url: null
                },
                error: _t190
              }));
            case 4:
              throw _t190;
            case 5:
              return _context240.a(2);
          }
        }, _callee239, null, [[0, 3]]);
      }))();
    }
    linkIdentityIdToken(e) {
      var _this162 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee241() {
        return _regenerator().w(function (_context242) {
          while (1) switch (_context242.n) {
            case 0:
              _context242.n = 1;
              return _this162._useSession(/*#__PURE__*/function () {
                var _ref72 = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee240(t) {
                  var _r$access_token, n, r, i, a, o, s, c, _yield$Y12, _l5, _u5, _t191, _t192, _t193, _t194;
                  return _regenerator().w(function (_context241) {
                    while (1) switch (_context241.p = _context241.n) {
                      case 0:
                        _context241.p = 0;
                        n = t.error, r = t.data.session;
                        if (!n) {
                          _context241.n = 1;
                          break;
                        }
                        throw n;
                      case 1:
                        i = e.options;
                        a = e.provider;
                        o = e.token;
                        s = e.access_token;
                        c = e.nonce;
                        _context241.n = 2;
                        return Y(_this162.fetch, `POST`, `${_this162.url}/token?grant_type=id_token`, {
                          headers: _this162.headers,
                          jwt: (_r$access_token = r === null || r === void 0 ? void 0 : r.access_token) !== null && _r$access_token !== void 0 ? _r$access_token : void 0,
                          body: {
                            provider: a,
                            id_token: o,
                            access_token: s,
                            nonce: c,
                            link_identity: !0,
                            gotrue_meta_security: {
                              captcha_token: i === null || i === void 0 ? void 0 : i.captchaToken
                            }
                          },
                          xform: X
                        });
                      case 2:
                        _yield$Y12 = _context241.v;
                        _l5 = _yield$Y12.data;
                        _u5 = _yield$Y12.error;
                        if (!_u5) {
                          _context241.n = 3;
                          break;
                        }
                        _t191 = _this162._returnResult({
                          data: {
                            user: null,
                            session: null
                          },
                          error: _u5
                        });
                        _context241.n = 8;
                        break;
                      case 3:
                        if (!(!_l5 || !_l5.session || !_l5.user)) {
                          _context241.n = 4;
                          break;
                        }
                        _t192 = _this162._returnResult({
                          data: {
                            user: null,
                            session: null
                          },
                          error: new R()
                        });
                        _context241.n = 7;
                        break;
                      case 4:
                        _t193 = _l5.session;
                        if (!_t193) {
                          _context241.n = 6;
                          break;
                        }
                        _context241.n = 5;
                        return _this162._saveSession(_l5.session);
                      case 5:
                        _context241.n = 6;
                        return _this162._notifyAllSubscribers(`USER_UPDATED`, _l5.session);
                      case 6:
                        _t192 = _this162._returnResult({
                          data: _l5,
                          error: _u5
                        });
                      case 7:
                        _t191 = _t192;
                      case 8:
                        return _context241.a(2, _t191);
                      case 9:
                        _context241.p = 9;
                        _t194 = _context241.v;
                        _context241.n = 10;
                        return W(_this162.storage, `${_this162.storageKey}-code-verifier`);
                      case 10:
                        if (!P(_t194)) {
                          _context241.n = 11;
                          break;
                        }
                        return _context241.a(2, _this162._returnResult({
                          data: {
                            user: null,
                            session: null
                          },
                          error: _t194
                        }));
                      case 11:
                        throw _t194;
                      case 12:
                        return _context241.a(2);
                    }
                  }, _callee240, null, [[0, 9]]);
                }));
                return function (_x101) {
                  return _ref72.apply(this, arguments);
                };
              }());
            case 1:
              return _context242.a(2, _context242.v);
          }
        }, _callee241);
      }))();
    }
    unlinkIdentity(e) {
      var _this163 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee243() {
        var _t195;
        return _regenerator().w(function (_context244) {
          while (1) switch (_context244.p = _context244.n) {
            case 0:
              _context244.p = 0;
              _context244.n = 1;
              return _this163._useSession(/*#__PURE__*/function () {
                var _ref73 = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee242(t) {
                  var _n$session$access_tok2, _n$session3;
                  var n, r;
                  return _regenerator().w(function (_context243) {
                    while (1) switch (_context243.n) {
                      case 0:
                        n = t.data, r = t.error;
                        if (!r) {
                          _context243.n = 1;
                          break;
                        }
                        throw r;
                      case 1:
                        _context243.n = 2;
                        return Y(_this163.fetch, `DELETE`, `${_this163.url}/user/identities/${e.identity_id}`, {
                          headers: _this163.headers,
                          jwt: (_n$session$access_tok2 = (_n$session3 = n.session) === null || _n$session3 === void 0 ? void 0 : _n$session3.access_token) !== null && _n$session$access_tok2 !== void 0 ? _n$session$access_tok2 : void 0
                        });
                      case 2:
                        return _context243.a(2, _context243.v);
                    }
                  }, _callee242);
                }));
                return function (_x102) {
                  return _ref73.apply(this, arguments);
                };
              }());
            case 1:
              return _context244.a(2, _context244.v);
            case 2:
              _context244.p = 2;
              _t195 = _context244.v;
              if (!P(_t195)) {
                _context244.n = 3;
                break;
              }
              return _context244.a(2, _this163._returnResult({
                data: null,
                error: _t195
              }));
            case 3:
              throw _t195;
            case 4:
              return _context244.a(2);
          }
        }, _callee243, null, [[0, 2]]);
      }))();
    }
    _refreshAccessToken(e) {
      var _this164 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee245() {
        var t, n, _t197;
        return _regenerator().w(function (_context246) {
          while (1) switch (_context246.p = _context246.n) {
            case 0:
              t = `#_refreshAccessToken()`;
              _this164._debug(t, `begin`);
              _context246.p = 1;
              n = Date.now();
              _context246.n = 2;
              return pr(/*#__PURE__*/function () {
                var _ref74 = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee244(n) {
                  var _t196;
                  return _regenerator().w(function (_context245) {
                    while (1) switch (_context245.n) {
                      case 0:
                        _t196 = n > 0;
                        if (!_t196) {
                          _context245.n = 1;
                          break;
                        }
                        _context245.n = 1;
                        return fr(200 * Math.pow(2, n - 1));
                      case 1:
                        _this164._debug(t, `refreshing attempt`, n);
                        _context245.n = 2;
                        return Y(_this164.fetch, `POST`, `${_this164.url}/token?grant_type=refresh_token`, {
                          body: {
                            refresh_token: e
                          },
                          headers: _this164.headers,
                          xform: X
                        });
                      case 2:
                        return _context245.a(2, _context245.v);
                    }
                  }, _callee244);
                }));
                return function (_x103) {
                  return _ref74.apply(this, arguments);
                };
              }(), (e, t) => {
                var r = 200 * Math.pow(2, e);
                return t && Vn(t) && Date.now() + r - n < M;
              });
            case 2:
              return _context246.a(2, _context246.v);
            case 3:
              _context246.p = 3;
              _t197 = _context246.v;
              if (!(_this164._debug(t, `error`, _t197), P(_t197))) {
                _context246.n = 4;
                break;
              }
              return _context246.a(2, _this164._returnResult({
                data: {
                  session: null,
                  user: null
                },
                error: _t197
              }));
            case 4:
              throw _t197;
            case 5:
              _context246.p = 5;
              _this164._debug(t, `end`);
              return _context246.f(5);
            case 6:
              return _context246.a(2);
          }
        }, _callee245, null, [[1, 3, 5, 6]]);
      }))();
    }
    _isValidSession(e) {
      return typeof e == `object` && !!e && `access_token` in e && `refresh_token` in e && `expires_at` in e;
    }
    _handleProviderSignIn(e, t) {
      var _this165 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee246() {
        var n;
        return _regenerator().w(function (_context247) {
          while (1) switch (_context247.n) {
            case 0:
              _context247.n = 1;
              return _this165._getUrlForProvider(`${_this165.url}/authorize`, e, {
                redirectTo: t.redirectTo,
                scopes: t.scopes,
                queryParams: t.queryParams
              });
            case 1:
              n = _context247.v;
              return _context247.a(2, (_this165._debug(`#_handleProviderSignIn()`, `provider`, e, `options`, t, `url`, n), V() && !t.skipBrowserRedirect && window.location.assign(n), {
                data: {
                  provider: e,
                  url: n
                },
                error: null
              }));
          }
        }, _callee246);
      }))();
    }
    _recoverAndRefresh() {
      var _this166 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee247() {
        var e, _t198$expires_at, _t198, _e56$user, _e57, _e56, _e58, n, _yield$_this166$_call, _n24, _yield$_this166$_getU, _n25, r, _t199, _t200, _t201, _t202;
        return _regenerator().w(function (_context248) {
          while (1) switch (_context248.p = _context248.n) {
            case 0:
              e = `#_recoverAndRefresh()`;
              _this166._debug(e, `begin`);
              _context248.p = 1;
              _context248.n = 2;
              return U(_this166.storage, _this166.storageKey);
            case 2:
              _t198 = _context248.v;
              if (!(_t198 && _this166.userStorage)) {
                _context248.n = 5;
                break;
              }
              _context248.n = 3;
              return U(_this166.userStorage, _this166.storageKey + `-user`);
            case 3:
              _e56 = _context248.v;
              _t199 = !_this166.storage.isServer && Object.is(_this166.storage, _this166.userStorage) && !_e56;
              if (!_t199) {
                _context248.n = 4;
                break;
              }
              _e56 = {
                user: _t198.user
              };
              _context248.n = 4;
              return lr(_this166.userStorage, _this166.storageKey + `-user`, _e56);
            case 4:
              _t198.user = (_e56$user = (_e57 = _e56) === null || _e57 === void 0 ? void 0 : _e57.user) !== null && _e56$user !== void 0 ? _e56$user : Cr();
              _context248.n = 10;
              break;
            case 5:
              if (!(_t198 && !_t198.user && !_t198.user)) {
                _context248.n = 10;
                break;
              }
              _context248.n = 6;
              return U(_this166.storage, _this166.storageKey + `-user`);
            case 6:
              _e58 = _context248.v;
              if (!(_e58 && _e58 !== null && _e58 !== void 0 && _e58.user)) {
                _context248.n = 9;
                break;
              }
              _t198.user = _e58.user;
              _context248.n = 7;
              return W(_this166.storage, _this166.storageKey + `-user`);
            case 7:
              _context248.n = 8;
              return lr(_this166.storage, _this166.storageKey, _t198);
            case 8:
              _context248.n = 10;
              break;
            case 9:
              _t198.user = Cr();
            case 10:
              if (!(_this166._debug(e, `session from storage`, _t198), !_this166._isValidSession(_t198))) {
                _context248.n = 12;
                break;
              }
              _this166._debug(e, `session is not valid`);
              _t200 = _t198 !== null;
              if (!_t200) {
                _context248.n = 11;
                break;
              }
              _context248.n = 11;
              return _this166._removeSession();
            case 11:
              return _context248.a(2);
            case 12:
              n = ((_t198$expires_at = _t198.expires_at) !== null && _t198$expires_at !== void 0 ? _t198$expires_at : 1 / 0) * 1e3 - Date.now() < En;
              if (!(_this166._debug(e, `session has${n ? `` : ` not`} expired with margin of ${En}s`), n)) {
                _context248.n = 15;
                break;
              }
              if (!(_this166.autoRefreshToken && _t198.refresh_token)) {
                _context248.n = 14;
                break;
              }
              _context248.n = 13;
              return _this166._callRefreshToken(_t198.refresh_token);
            case 13:
              _yield$_this166$_call = _context248.v;
              _n24 = _yield$_this166$_call.error;
              _n24 && (Un(_n24) ? _this166._debug(e, `refresh discarded by commit guard`, _n24) : _this166._debug(e, `refresh failed`, _n24));
            case 14:
              _context248.n = 25;
              break;
            case 15:
              if (!(_t198.user && _t198.user.__isUserNotAvailableProxy === !0)) {
                _context248.n = 24;
                break;
              }
              _context248.p = 16;
              _context248.n = 17;
              return _this166._getUser(_t198.access_token);
            case 17:
              _yield$_this166$_getU = _context248.v;
              _n25 = _yield$_this166$_getU.data;
              r = _yield$_this166$_getU.error;
              if (!(!r && _n25 !== null && _n25 !== void 0 && _n25.user)) {
                _context248.n = 20;
                break;
              }
              _t198.user = _n25.user;
              _context248.n = 18;
              return _this166._saveSession(_t198);
            case 18:
              _context248.n = 19;
              return _this166._notifyAllSubscribers(`SIGNED_IN`, _t198);
            case 19:
              _context248.n = 21;
              break;
            case 20:
              _this166._debug(e, `could not get user data, skipping SIGNED_IN notification`);
            case 21:
              _context248.n = 23;
              break;
            case 22:
              _context248.p = 22;
              _t201 = _context248.v;
              console.error(`Error getting user data:`, _t201), _this166._debug(e, `error getting user data, skipping SIGNED_IN notification`, _t201);
            case 23:
              _context248.n = 25;
              break;
            case 24:
              _context248.n = 25;
              return _this166._notifyAllSubscribers(`SIGNED_IN`, _t198);
            case 25:
              _context248.n = 27;
              break;
            case 26:
              _context248.p = 26;
              _t202 = _context248.v;
              _this166._debug(e, `error`, _t202), console.error(_t202);
              return _context248.a(2);
            case 27:
              _context248.p = 27;
              _this166._debug(e, `end`);
              return _context248.f(27);
            case 28:
              return _context248.a(2);
          }
        }, _callee247, null, [[16, 22], [1, 26, 27, 28]]);
      }))();
    }
    _callRefreshToken(e) {
      var _this167 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee248() {
        var t, n, r, _t203, _yield$_this167$_refr, _n26, i, a, _e59, o, _e60, s, _n27, _e61, _t204, _t205;
        return _regenerator().w(function (_context249) {
          while (1) switch (_context249.p = _context249.n) {
            case 0:
              if (e) {
                _context249.n = 1;
                break;
              }
              throw new L();
            case 1:
              if (!_this167.refreshingDeferred) {
                _context249.n = 2;
                break;
              }
              return _context249.a(2, _this167.refreshingDeferred.promise);
            case 2:
              if (!(_this167.lastRefreshFailure && _this167.lastRefreshFailure.refreshToken === e && Date.now() < _this167.lastRefreshFailure.expiresAt)) {
                _context249.n = 3;
                break;
              }
              return _context249.a(2, (_this167._debug(`#_callRefreshToken()`, `returning cached failure (cooldown active)`), _this167.lastRefreshFailure.result));
            case 3:
              r = `#_callRefreshToken()`;
              _this167._debug(r, `begin`);
              _context249.p = 4;
              _this167.refreshingDeferred = new ur();
              _context249.n = 5;
              return U(_this167.storage, _this167.storageKey);
            case 5:
              _t203 = _context249.v;
              _context249.n = 6;
              return _this167._refreshAccessToken(e);
            case 6:
              _yield$_this167$_refr = _context249.v;
              _n26 = _yield$_this167$_refr.data;
              i = _yield$_this167$_refr.error;
              if (!i) {
                _context249.n = 7;
                break;
              }
              throw i;
            case 7:
              if (_n26.session) {
                _context249.n = 8;
                break;
              }
              throw new L();
            case 8:
              _context249.n = 9;
              return U(_this167.storage, _this167.storageKey);
            case 9:
              a = _context249.v;
              if (!(_t203 !== null && (a === null || a.refresh_token !== _t203.refresh_token))) {
                _context249.n = 10;
                break;
              }
              _this167._debug(r, `commit guard: storage changed since refresh started, discarding rotated tokens`, {
                startedWith: `present`,
                nowHolds: a ? `replaced` : `cleared`
              });
              _e59 = {
                data: null,
                error: new Hn()
              };
              return _context249.a(2, (_this167.refreshingDeferred.resolve(_e59), _e59));
            case 10:
              o = _this167._sessionRemovalEpoch;
              _context249.n = 11;
              return _this167._saveSession(_n26.session);
            case 11:
              if (!(_this167._sessionRemovalEpoch !== o)) {
                _context249.n = 14;
                break;
              }
              _this167._debug(r, `commit guard (post-save): _removeSession ran during _saveSession, undoing write`);
              _context249.n = 12;
              return W(_this167.storage, _this167.storageKey);
            case 12:
              _t204 = _this167.userStorage;
              if (!_t204) {
                _context249.n = 13;
                break;
              }
              _context249.n = 13;
              return W(_this167.userStorage, _this167.storageKey + `-user`);
            case 13:
              _e60 = {
                data: null,
                error: new Hn()
              };
              return _context249.a(2, (_this167.refreshingDeferred.resolve(_e60), _e60));
            case 14:
              _context249.n = 15;
              return _this167._notifyAllSubscribers(`TOKEN_REFRESHED`, _n26.session);
            case 15:
              s = {
                data: _n26.session,
                error: null
              };
              return _context249.a(2, (_this167.lastRefreshFailure = null, _this167.refreshingDeferred.resolve(s), s));
            case 16:
              _context249.p = 16;
              _t205 = _context249.v;
              if (!(_this167._debug(r, `error`, _t205), P(_t205))) {
                _context249.n = 20;
                break;
              }
              _n27 = {
                data: null,
                error: _t205
              };
              if (Vn(_t205)) {
                _context249.n = 19;
                break;
              }
              _context249.n = 17;
              return U(_this167.storage, _this167.storageKey);
            case 17:
              _e61 = _context249.v;
              if (!(_e61 !== null && _e61 !== void 0 && _e61.expires_at && _e61.expires_at * 1e3 > Date.now())) {
                _context249.n = 18;
                break;
              }
              _this167._debug(r, `proactive refresh failed, access token still valid — preserving session`);
              _context249.n = 19;
              break;
            case 18:
              _context249.n = 19;
              return _this167._removeSession();
            case 19:
              return _context249.a(2, (_this167.lastRefreshFailure = {
                refreshToken: e,
                result: _n27,
                expiresAt: Date.now() + 6e4
              }, (t = _this167.refreshingDeferred) == null || t.resolve(_n27), _n27));
            case 20:
              throw (n = _this167.refreshingDeferred) == null || n.reject(_t205), _t205;
            case 21:
              _context249.p = 21;
              _this167.refreshingDeferred = null, _this167._debug(r, `end`);
              return _context249.f(21);
            case 22:
              return _context249.a(2);
          }
        }, _callee248, null, [[4, 16, 21, 22]]);
      }))();
    }
    _notifyAllSubscribers(_x104, _x105) {
      var _this168 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee250(e, t, n = !0) {
        var r, _r21, i, _e62;
        return _regenerator().w(function (_context251) {
          while (1) switch (_context251.p = _context251.n) {
            case 0:
              r = `#_notifyAllSubscribers(${e})`;
              _this168._debug(r, `begin`, t, `broadcast = ${n}`);
              _context251.p = 1;
              _this168.broadcastChannel && n && _this168.broadcastChannel.postMessage({
                event: e,
                session: t
              });
              _r21 = [], i = Array.from(_this168.stateChangeEmitters.values()).map(/*#__PURE__*/function () {
                var _ref75 = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee249(n) {
                  var _t206;
                  return _regenerator().w(function (_context250) {
                    while (1) switch (_context250.p = _context250.n) {
                      case 0:
                        _context250.p = 0;
                        _context250.n = 1;
                        return n.callback(e, t);
                      case 1:
                        _context250.n = 3;
                        break;
                      case 2:
                        _context250.p = 2;
                        _t206 = _context250.v;
                        _r21.push(_t206);
                      case 3:
                        return _context250.a(2);
                    }
                  }, _callee249, null, [[0, 2]]);
                }));
                return function (_x106) {
                  return _ref75.apply(this, arguments);
                };
              }());
              _context251.n = 2;
              return Promise.all(i);
            case 2:
              if (!(_r21.length > 0)) {
                _context251.n = 3;
                break;
              }
              for (_e62 = 0; _e62 < _r21.length; _e62 += 1) console.error(_r21[_e62]);
              throw _r21[0];
            case 3:
              _context251.p = 3;
              _this168._debug(r, `end`);
              return _context251.f(3);
            case 4:
              return _context251.a(2);
          }
        }, _callee250, null, [[1,, 3, 4]]);
      })).apply(this, arguments);
    }
    _saveSession(e) {
      var _this169 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee251() {
        var t, n, _e63, r, _e64, _t207;
        return _regenerator().w(function (_context252) {
          while (1) switch (_context252.n) {
            case 0:
              _this169._debug(`#_saveSession()`, e);
              _this169.suppressGetSessionWarning = !0;
              _context252.n = 1;
              return W(_this169.storage, `${_this169.storageKey}-code-verifier`);
            case 1:
              t = Object.assign({}, e), n = t.user && t.user.__isUserNotAvailableProxy === !0;
              if (!_this169.userStorage) {
                _context252.n = 4;
                break;
              }
              _t207 = !n && t.user;
              if (!_t207) {
                _context252.n = 2;
                break;
              }
              _context252.n = 2;
              return lr(_this169.userStorage, _this169.storageKey + `-user`, {
                user: t.user
              });
            case 2:
              _e63 = Object.assign({}, t);
              delete _e63.user;
              r = Tr(_e63);
              _context252.n = 3;
              return lr(_this169.storage, _this169.storageKey, r);
            case 3:
              _context252.n = 5;
              break;
            case 4:
              _e64 = Tr(t);
              _context252.n = 5;
              return lr(_this169.storage, _this169.storageKey, _e64);
            case 5:
              return _context252.a(2);
          }
        }, _callee251);
      }))();
    }
    _removeSession() {
      var _this170 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee252() {
        var _t208;
        return _regenerator().w(function (_context253) {
          while (1) switch (_context253.n) {
            case 0:
              _this170._sessionRemovalEpoch += 1;
              _this170._debug(`#_removeSession()`);
              _this170.lastRefreshFailure = null;
              _this170.suppressGetSessionWarning = !1;
              _context253.n = 1;
              return W(_this170.storage, _this170.storageKey);
            case 1:
              _context253.n = 2;
              return W(_this170.storage, _this170.storageKey + `-code-verifier`);
            case 2:
              _context253.n = 3;
              return W(_this170.storage, _this170.storageKey + `-user`);
            case 3:
              _t208 = _this170.userStorage;
              if (!_t208) {
                _context253.n = 4;
                break;
              }
              _context253.n = 4;
              return W(_this170.userStorage, _this170.storageKey + `-user`);
            case 4:
              _context253.n = 5;
              return _this170._notifyAllSubscribers(`SIGNED_OUT`, null);
            case 5:
              return _context253.a(2);
          }
        }, _callee252);
      }))();
    }
    _removeVisibilityChangedCallback() {
      this._debug(`#_removeVisibilityChangedCallback()`);
      var e = this.visibilityChangedCallback;
      this.visibilityChangedCallback = null;
      try {
        e && V() && window != null && window.removeEventListener && window.removeEventListener(`visibilitychange`, e);
      } catch (e) {
        console.error(`removing visibilitychange callback failed`, e);
      }
    }
    _startAutoRefresh() {
      var _this171 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee254() {
        var e, t;
        return _regenerator().w(function (_context255) {
          while (1) switch (_context255.n) {
            case 0:
              _context255.n = 1;
              return _this171._stopAutoRefresh();
            case 1:
              _this171._debug(`#_startAutoRefresh()`);
              e = setInterval(() => _this171._autoRefreshTokenTick(), M);
              _this171.autoRefreshTicker = e, e && typeof e == `object` && typeof e.unref == `function` ? e.unref() : typeof Deno < `u` && typeof Deno.unrefTimer == `function` && Deno.unrefTimer(e);
              t = setTimeout(/*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee253() {
                return _regenerator().w(function (_context254) {
                  while (1) switch (_context254.n) {
                    case 0:
                      _context254.n = 1;
                      return _this171.initializePromise;
                    case 1:
                      _context254.n = 2;
                      return _this171._autoRefreshTokenTick();
                    case 2:
                      return _context254.a(2);
                  }
                }, _callee253);
              })), 0);
              _this171.autoRefreshTickTimeout = t, t && typeof t == `object` && typeof t.unref == `function` ? t.unref() : typeof Deno < `u` && typeof Deno.unrefTimer == `function` && Deno.unrefTimer(t);
            case 2:
              return _context255.a(2);
          }
        }, _callee254);
      }))();
    }
    _stopAutoRefresh() {
      var _this172 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee255() {
        var e, t;
        return _regenerator().w(function (_context256) {
          while (1) switch (_context256.n) {
            case 0:
              _this172._debug(`#_stopAutoRefresh()`);
              e = _this172.autoRefreshTicker;
              _this172.autoRefreshTicker = null, e && clearInterval(e);
              t = _this172.autoRefreshTickTimeout;
              _this172.autoRefreshTickTimeout = null, t && clearTimeout(t);
            case 1:
              return _context256.a(2);
          }
        }, _callee255);
      }))();
    }
    startAutoRefresh() {
      var _this173 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee256() {
        return _regenerator().w(function (_context257) {
          while (1) switch (_context257.n) {
            case 0:
              _this173._removeVisibilityChangedCallback();
              _context257.n = 1;
              return _this173._startAutoRefresh();
            case 1:
              return _context257.a(2);
          }
        }, _callee256);
      }))();
    }
    stopAutoRefresh() {
      var _this174 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee257() {
        return _regenerator().w(function (_context258) {
          while (1) switch (_context258.n) {
            case 0:
              _this174._removeVisibilityChangedCallback();
              _context258.n = 1;
              return _this174._stopAutoRefresh();
            case 1:
              return _context258.a(2);
          }
        }, _callee257);
      }))();
    }
    dispose() {
      var _this175 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee258() {
        var e;
        return _regenerator().w(function (_context259) {
          while (1) switch (_context259.n) {
            case 0:
              _this175._removeVisibilityChangedCallback();
              _context259.n = 1;
              return _this175._stopAutoRefresh();
            case 1:
              (e = _this175.broadcastChannel) == null || e.close();
              _this175.broadcastChannel = null;
              _this175.stateChangeEmitters.clear();
            case 2:
              return _context259.a(2);
          }
        }, _callee258);
      }))();
    }
    _autoRefreshTokenTick() {
      var _this176 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee262() {
        var e, _t212, _t213;
        return _regenerator().w(function (_context263) {
          while (1) switch (_context263.p = _context263.n) {
            case 0:
              if (!(_this176._debug(`#_autoRefreshTokenTick()`, `begin`), _this176.lock != null)) {
                _context263.n = 6;
                break;
              }
              _context263.p = 1;
              _context263.n = 2;
              return _this176._acquireLock(0, /*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee260() {
                var e, _t210;
                return _regenerator().w(function (_context261) {
                  while (1) switch (_context261.p = _context261.n) {
                    case 0:
                      _context261.p = 0;
                      e = Date.now();
                      _context261.p = 1;
                      _context261.n = 2;
                      return _this176._useSession(/*#__PURE__*/function () {
                        var _ref78 = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee259(t) {
                          var n, r, _t209;
                          return _regenerator().w(function (_context260) {
                            while (1) switch (_context260.n) {
                              case 0:
                                n = t.data.session;
                                if (!(!n || !n.refresh_token || !n.expires_at)) {
                                  _context260.n = 1;
                                  break;
                                }
                                _this176._debug(`#_autoRefreshTokenTick()`, `no session`);
                                return _context260.a(2);
                              case 1:
                                r = Math.floor((n.expires_at * 1e3 - e) / M);
                                _this176._debug(`#_autoRefreshTokenTick()`, `access token expires in ${r} ticks, a tick lasts ${M}ms, refresh threshold is 3 ticks`);
                                _t209 = r <= 3;
                                if (!_t209) {
                                  _context260.n = 2;
                                  break;
                                }
                                _context260.n = 2;
                                return _this176._callRefreshToken(n.refresh_token);
                              case 2:
                                return _context260.a(2);
                            }
                          }, _callee259);
                        }));
                        return function (_x107) {
                          return _ref78.apply(this, arguments);
                        };
                      }());
                    case 2:
                      return _context261.a(2, _context261.v);
                    case 3:
                      _context261.p = 3;
                      _t210 = _context261.v;
                      console.error(`Auto refresh tick failed with error. This is likely a transient error.`, _t210);
                    case 4:
                      _context261.p = 4;
                      _this176._debug(`#_autoRefreshTokenTick()`, `end`);
                      return _context261.f(4);
                    case 5:
                      return _context261.a(2);
                  }
                }, _callee260, null, [[1, 3], [0,, 4, 5]]);
              })));
            case 2:
              _context263.n = 5;
              break;
            case 3:
              _context263.p = 3;
              _t212 = _context263.v;
              if (!(_t212 instanceof Rr)) {
                _context263.n = 4;
                break;
              }
              _this176._debug(`auto refresh token tick lock not available`);
              _context263.n = 5;
              break;
            case 4:
              throw _t212;
            case 5:
              return _context263.a(2);
            case 6:
              if (!(_this176.refreshingDeferred !== null)) {
                _context263.n = 7;
                break;
              }
              _this176._debug(`#_autoRefreshTokenTick()`, `refresh already in flight, skipping`);
              return _context263.a(2);
            case 7:
              _context263.p = 7;
              e = Date.now();
              _context263.p = 8;
              _context263.n = 9;
              return _this176._useSession(/*#__PURE__*/function () {
                var _ref79 = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee261(t) {
                  var n, r, _t211;
                  return _regenerator().w(function (_context262) {
                    while (1) switch (_context262.n) {
                      case 0:
                        n = t.data.session;
                        if (!(!n || !n.refresh_token || !n.expires_at)) {
                          _context262.n = 1;
                          break;
                        }
                        _this176._debug(`#_autoRefreshTokenTick()`, `no session`);
                        return _context262.a(2);
                      case 1:
                        r = Math.floor((n.expires_at * 1e3 - e) / M);
                        _this176._debug(`#_autoRefreshTokenTick()`, `access token expires in ${r} ticks, a tick lasts ${M}ms, refresh threshold is 3 ticks`);
                        _t211 = r <= 3;
                        if (!_t211) {
                          _context262.n = 2;
                          break;
                        }
                        _context262.n = 2;
                        return _this176._callRefreshToken(n.refresh_token);
                      case 2:
                        return _context262.a(2);
                    }
                  }, _callee261);
                }));
                return function (_x108) {
                  return _ref79.apply(this, arguments);
                };
              }());
            case 9:
              _context263.n = 11;
              break;
            case 10:
              _context263.p = 10;
              _t213 = _context263.v;
              console.error(`Auto refresh tick failed with error. This is likely a transient error.`, _t213);
            case 11:
              _context263.p = 11;
              _this176._debug(`#_autoRefreshTokenTick()`, `end`);
              return _context263.f(11);
            case 12:
              return _context263.a(2);
          }
        }, _callee262, null, [[8, 10], [7,, 11, 12], [1, 3]]);
      }))();
    }
    _handleVisibilityChange() {
      var _this177 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee264() {
        var _t215;
        return _regenerator().w(function (_context265) {
          while (1) switch (_context265.p = _context265.n) {
            case 0:
              if (!(_this177._debug(`#_handleVisibilityChange()`), !V() || !(window != null && window.addEventListener))) {
                _context265.n = 1;
                break;
              }
              return _context265.a(2, (_this177.autoRefreshToken && _this177.startAutoRefresh(), !1));
            case 1:
              _context265.p = 1;
              _this177.visibilityChangedCallback = /*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee263() {
                var _t214;
                return _regenerator().w(function (_context264) {
                  while (1) switch (_context264.p = _context264.n) {
                    case 0:
                      _context264.p = 0;
                      _context264.n = 1;
                      return _this177._onVisibilityChanged(!1);
                    case 1:
                      _context264.n = 3;
                      break;
                    case 2:
                      _context264.p = 2;
                      _t214 = _context264.v;
                      _this177._debug(`#visibilityChangedCallback`, `error`, _t214);
                    case 3:
                      return _context264.a(2);
                  }
                }, _callee263, null, [[0, 2]]);
              }));
              window == null || window.addEventListener(`visibilitychange`, _this177.visibilityChangedCallback);
              _context265.n = 2;
              return _this177._onVisibilityChanged(!0);
            case 2:
              _context265.n = 4;
              break;
            case 3:
              _context265.p = 3;
              _t215 = _context265.v;
              console.error(`_handleVisibilityChange`, _t215);
            case 4:
              return _context265.a(2);
          }
        }, _callee264, null, [[1, 3]]);
      }))();
    }
    _onVisibilityChanged(e) {
      var _this178 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee266() {
        var t;
        return _regenerator().w(function (_context267) {
          while (1) switch (_context267.n) {
            case 0:
              t = `#_onVisibilityChanged(${e})`;
              if (!(_this178._debug(t, `visibilityState`, document.visibilityState), document.visibilityState === `visible`)) {
                _context267.n = 6;
                break;
              }
              if (!(_this178.autoRefreshToken && _this178._startAutoRefresh(), !e)) {
                _context267.n = 5;
                break;
              }
              _context267.n = 1;
              return _this178.initializePromise;
            case 1:
              if (!(_this178.lock != null)) {
                _context267.n = 3;
                break;
              }
              _context267.n = 2;
              return _this178._acquireLock(_this178.lockAcquireTimeout, /*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee265() {
                return _regenerator().w(function (_context266) {
                  while (1) switch (_context266.n) {
                    case 0:
                      if (!(document.visibilityState !== `visible`)) {
                        _context266.n = 1;
                        break;
                      }
                      _this178._debug(t, `acquired the lock to recover the session, but the browser visibilityState is no longer visible, aborting`);
                      return _context266.a(2);
                    case 1:
                      _context266.n = 2;
                      return _this178._recoverAndRefresh();
                    case 2:
                      return _context266.a(2);
                  }
                }, _callee265);
              })));
            case 2:
              _context267.n = 5;
              break;
            case 3:
              if (!(document.visibilityState !== `visible`)) {
                _context267.n = 4;
                break;
              }
              _this178._debug(t, `visibilityState is no longer visible, skipping recovery`);
              return _context267.a(2);
            case 4:
              _context267.n = 5;
              return _this178._recoverAndRefresh();
            case 5:
              _context267.n = 7;
              break;
            case 6:
              document.visibilityState === `hidden` && _this178.autoRefreshToken && _this178._stopAutoRefresh();
            case 7:
              return _context267.a(2);
          }
        }, _callee266);
      }))();
    }
    _getUrlForProvider(e, t, n) {
      var _this179 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee267() {
        var r, _yield$G11, _yield$G12, _e65, _t216, _n28, _e66;
        return _regenerator().w(function (_context268) {
          while (1) switch (_context268.n) {
            case 0:
              r = [`provider=${encodeURIComponent(t)}`];
              if (!(n !== null && n !== void 0 && n.redirectTo && r.push(`redirect_to=${encodeURIComponent(n.redirectTo)}`), n !== null && n !== void 0 && n.scopes && r.push(`scopes=${encodeURIComponent(n.scopes)}`), _this179.flowType === `pkce`)) {
                _context268.n = 2;
                break;
              }
              _context268.n = 1;
              return G(_this179.storage, _this179.storageKey);
            case 1:
              _yield$G11 = _context268.v;
              _yield$G12 = _slicedToArray(_yield$G11, 2);
              _e65 = _yield$G12[0];
              _t216 = _yield$G12[1];
              _n28 = new URLSearchParams({
                code_challenge: `${encodeURIComponent(_e65)}`,
                code_challenge_method: `${encodeURIComponent(_t216)}`
              });
              r.push(_n28.toString());
            case 2:
              if (n !== null && n !== void 0 && n.queryParams) {
                _e66 = new URLSearchParams(n.queryParams);
                r.push(_e66.toString());
              }
              return _context268.a(2, (n !== null && n !== void 0 && n.skipBrowserRedirect && r.push(`skip_http_redirect=${n.skipBrowserRedirect}`), `${e}?${r.join(`&`)}`));
          }
        }, _callee267);
      }))();
    }
    _unenroll(e) {
      var _this180 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee269() {
        var _t218;
        return _regenerator().w(function (_context270) {
          while (1) switch (_context270.p = _context270.n) {
            case 0:
              _context270.p = 0;
              _context270.n = 1;
              return _this180._useSession(/*#__PURE__*/function () {
                var _ref82 = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee268(t) {
                  var _n$session4;
                  var n, r, _t217;
                  return _regenerator().w(function (_context269) {
                    while (1) switch (_context269.n) {
                      case 0:
                        n = t.data, r = t.error;
                        if (!r) {
                          _context269.n = 1;
                          break;
                        }
                        _t217 = _this180._returnResult({
                          data: null,
                          error: r
                        });
                        _context269.n = 3;
                        break;
                      case 1:
                        _context269.n = 2;
                        return Y(_this180.fetch, `DELETE`, `${_this180.url}/factors/${e.factorId}`, {
                          headers: _this180.headers,
                          jwt: n === null || n === void 0 || (_n$session4 = n.session) === null || _n$session4 === void 0 ? void 0 : _n$session4.access_token
                        });
                      case 2:
                        _t217 = _context269.v;
                      case 3:
                        return _context269.a(2, _t217);
                    }
                  }, _callee268);
                }));
                return function (_x109) {
                  return _ref82.apply(this, arguments);
                };
              }());
            case 1:
              return _context270.a(2, _context270.v);
            case 2:
              _context270.p = 2;
              _t218 = _context270.v;
              if (!P(_t218)) {
                _context270.n = 3;
                break;
              }
              return _context270.a(2, _this180._returnResult({
                data: null,
                error: _t218
              }));
            case 3:
              throw _t218;
            case 4:
              return _context270.a(2);
          }
        }, _callee269, null, [[0, 2]]);
      }))();
    }
    _enroll(e) {
      var _this181 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee271() {
        var _t219;
        return _regenerator().w(function (_context272) {
          while (1) switch (_context272.p = _context272.n) {
            case 0:
              _context272.p = 0;
              _context272.n = 1;
              return _this181._useSession(/*#__PURE__*/function () {
                var _ref83 = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee270(t) {
                  var _n$session5, _a$totp;
                  var n, r, i, _yield$Y13, a, o;
                  return _regenerator().w(function (_context271) {
                    while (1) switch (_context271.n) {
                      case 0:
                        n = t.data, r = t.error;
                        if (!r) {
                          _context271.n = 1;
                          break;
                        }
                        return _context271.a(2, _this181._returnResult({
                          data: null,
                          error: r
                        }));
                      case 1:
                        i = Object.assign({
                          friendly_name: e.friendlyName,
                          factor_type: e.factorType
                        }, e.factorType === `phone` ? {
                          phone: e.phone
                        } : e.factorType === `totp` ? {
                          issuer: e.issuer
                        } : {});
                        _context271.n = 2;
                        return Y(_this181.fetch, `POST`, `${_this181.url}/factors`, {
                          body: i,
                          headers: _this181.headers,
                          jwt: n === null || n === void 0 || (_n$session5 = n.session) === null || _n$session5 === void 0 ? void 0 : _n$session5.access_token
                        });
                      case 2:
                        _yield$Y13 = _context271.v;
                        a = _yield$Y13.data;
                        o = _yield$Y13.error;
                        return _context271.a(2, o ? _this181._returnResult({
                          data: null,
                          error: o
                        }) : (e.factorType === `totp` && a.type === `totp` && a !== null && a !== void 0 && (_a$totp = a.totp) !== null && _a$totp !== void 0 && _a$totp.qr_code && (a.totp.qr_code = `data:image/svg+xml;utf-8,${a.totp.qr_code}`), _this181._returnResult({
                          data: a,
                          error: null
                        })));
                    }
                  }, _callee270);
                }));
                return function (_x110) {
                  return _ref83.apply(this, arguments);
                };
              }());
            case 1:
              return _context272.a(2, _context272.v);
            case 2:
              _context272.p = 2;
              _t219 = _context272.v;
              if (!P(_t219)) {
                _context272.n = 3;
                break;
              }
              return _context272.a(2, _this181._returnResult({
                data: null,
                error: _t219
              }));
            case 3:
              throw _t219;
            case 4:
              return _context272.a(2);
          }
        }, _callee271, null, [[0, 2]]);
      }))();
    }
    _verify(e) {
      var _this182 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee274() {
        var t;
        return _regenerator().w(function (_context275) {
          while (1) switch (_context275.n) {
            case 0:
              t = /*#__PURE__*/function () {
                var _t220 = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee273() {
                  var _t222;
                  return _regenerator().w(function (_context274) {
                    while (1) switch (_context274.p = _context274.n) {
                      case 0:
                        _context274.p = 0;
                        _context274.n = 1;
                        return _this182._useSession(/*#__PURE__*/function () {
                          var _ref84 = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee272(t) {
                            var _n$session6;
                            var n, r, i, _yield$Y14, a, o, _t221;
                            return _regenerator().w(function (_context273) {
                              while (1) switch (_context273.n) {
                                case 0:
                                  n = t.data, r = t.error;
                                  if (!r) {
                                    _context273.n = 1;
                                    break;
                                  }
                                  return _context273.a(2, _this182._returnResult({
                                    data: null,
                                    error: r
                                  }));
                                case 1:
                                  i = Object.assign({
                                    challenge_id: e.challengeId
                                  }, `webauthn` in e ? {
                                    webauthn: Object.assign(Object.assign({}, e.webauthn), {
                                      credential_response: e.webauthn.type === `create` ? ti(e.webauthn.credential_response) : ni(e.webauthn.credential_response)
                                    })
                                  } : {
                                    code: e.code
                                  });
                                  _context273.n = 2;
                                  return Y(_this182.fetch, `POST`, `${_this182.url}/factors/${e.factorId}/verify`, {
                                    body: i,
                                    headers: _this182.headers,
                                    jwt: n === null || n === void 0 || (_n$session6 = n.session) === null || _n$session6 === void 0 ? void 0 : _n$session6.access_token
                                  });
                                case 2:
                                  _yield$Y14 = _context273.v;
                                  a = _yield$Y14.data;
                                  o = _yield$Y14.error;
                                  if (!o) {
                                    _context273.n = 3;
                                    break;
                                  }
                                  _t221 = _this182._returnResult({
                                    data: null,
                                    error: o
                                  });
                                  _context273.n = 6;
                                  break;
                                case 3:
                                  _context273.n = 4;
                                  return _this182._saveSession(Object.assign({
                                    expires_at: Math.round(Date.now() / 1e3) + a.expires_in
                                  }, a));
                                case 4:
                                  _context273.n = 5;
                                  return _this182._notifyAllSubscribers(`MFA_CHALLENGE_VERIFIED`, a);
                                case 5:
                                  _t221 = _this182._returnResult({
                                    data: a,
                                    error: o
                                  });
                                case 6:
                                  return _context273.a(2, _t221);
                              }
                            }, _callee272);
                          }));
                          return function (_x111) {
                            return _ref84.apply(this, arguments);
                          };
                        }());
                      case 1:
                        return _context274.a(2, _context274.v);
                      case 2:
                        _context274.p = 2;
                        _t222 = _context274.v;
                        if (!P(_t222)) {
                          _context274.n = 3;
                          break;
                        }
                        return _context274.a(2, _this182._returnResult({
                          data: null,
                          error: _t222
                        }));
                      case 3:
                        throw _t222;
                      case 4:
                        return _context274.a(2);
                    }
                  }, _callee273, null, [[0, 2]]);
                }));
                function t() {
                  return _t220.apply(this, arguments);
                }
                return t;
              }();
              return _context275.a(2, _this182.lock == null ? t() : _this182._acquireLock(_this182.lockAcquireTimeout, t));
          }
        }, _callee274);
      }))();
    }
    _challenge(e) {
      var _this183 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee277() {
        var t;
        return _regenerator().w(function (_context278) {
          while (1) switch (_context278.n) {
            case 0:
              t = /*#__PURE__*/function () {
                var _t223 = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee276() {
                  var _t225;
                  return _regenerator().w(function (_context277) {
                    while (1) switch (_context277.p = _context277.n) {
                      case 0:
                        _context277.p = 0;
                        _context277.n = 1;
                        return _this183._useSession(/*#__PURE__*/function () {
                          var _ref85 = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee275(t) {
                            var _n$session7;
                            var n, r, i, a, _t224;
                            return _regenerator().w(function (_context276) {
                              while (1) switch (_context276.n) {
                                case 0:
                                  n = t.data, r = t.error;
                                  if (!r) {
                                    _context276.n = 1;
                                    break;
                                  }
                                  return _context276.a(2, _this183._returnResult({
                                    data: null,
                                    error: r
                                  }));
                                case 1:
                                  _context276.n = 2;
                                  return Y(_this183.fetch, `POST`, `${_this183.url}/factors/${e.factorId}/challenge`, {
                                    body: e,
                                    headers: _this183.headers,
                                    jwt: n === null || n === void 0 || (_n$session7 = n.session) === null || _n$session7 === void 0 ? void 0 : _n$session7.access_token
                                  });
                                case 2:
                                  i = _context276.v;
                                  if (!i.error) {
                                    _context276.n = 3;
                                    break;
                                  }
                                  return _context276.a(2, i);
                                case 3:
                                  a = i.data;
                                  if (!(a.type !== `webauthn`)) {
                                    _context276.n = 4;
                                    break;
                                  }
                                  return _context276.a(2, {
                                    data: a,
                                    error: null
                                  });
                                case 4:
                                  _t224 = a.webauthn.type;
                                  _context276.n = _t224 === `create` ? 5 : _t224 === `request` ? 6 : 7;
                                  break;
                                case 5:
                                  return _context276.a(2, {
                                    data: Object.assign(Object.assign({}, a), {
                                      webauthn: Object.assign(Object.assign({}, a.webauthn), {
                                        credential_options: Object.assign(Object.assign({}, a.webauthn.credential_options), {
                                          publicKey: $r(a.webauthn.credential_options.publicKey)
                                        })
                                      })
                                    }),
                                    error: null
                                  });
                                case 6:
                                  return _context276.a(2, {
                                    data: Object.assign(Object.assign({}, a), {
                                      webauthn: Object.assign(Object.assign({}, a.webauthn), {
                                        credential_options: Object.assign(Object.assign({}, a.webauthn.credential_options), {
                                          publicKey: ei(a.webauthn.credential_options.publicKey)
                                        })
                                      })
                                    }),
                                    error: null
                                  });
                                case 7:
                                  return _context276.a(2);
                              }
                            }, _callee275);
                          }));
                          return function (_x112) {
                            return _ref85.apply(this, arguments);
                          };
                        }());
                      case 1:
                        return _context277.a(2, _context277.v);
                      case 2:
                        _context277.p = 2;
                        _t225 = _context277.v;
                        if (!P(_t225)) {
                          _context277.n = 3;
                          break;
                        }
                        return _context277.a(2, _this183._returnResult({
                          data: null,
                          error: _t225
                        }));
                      case 3:
                        throw _t225;
                      case 4:
                        return _context277.a(2);
                    }
                  }, _callee276, null, [[0, 2]]);
                }));
                function t() {
                  return _t223.apply(this, arguments);
                }
                return t;
              }();
              return _context278.a(2, _this183.lock == null ? t() : _this183._acquireLock(_this183.lockAcquireTimeout, t));
          }
        }, _callee277);
      }))();
    }
    _challengeAndVerify(e) {
      var _this184 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee278() {
        var _yield$_this184$_chal, t, n, _t226;
        return _regenerator().w(function (_context279) {
          while (1) switch (_context279.n) {
            case 0:
              _context279.n = 1;
              return _this184._challenge({
                factorId: e.factorId
              });
            case 1:
              _yield$_this184$_chal = _context279.v;
              t = _yield$_this184$_chal.data;
              n = _yield$_this184$_chal.error;
              if (!n) {
                _context279.n = 2;
                break;
              }
              _t226 = _this184._returnResult({
                data: null,
                error: n
              });
              _context279.n = 4;
              break;
            case 2:
              _context279.n = 3;
              return _this184._verify({
                factorId: e.factorId,
                challengeId: t.id,
                code: e.code
              });
            case 3:
              _t226 = _context279.v;
            case 4:
              return _context279.a(2, _t226);
          }
        }, _callee278);
      }))();
    }
    _listFactors() {
      var _this185 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee279() {
        var _e$factors;
        var _yield$_this185$getUs, e, t, n, _iterator5, _step5, _t227;
        return _regenerator().w(function (_context280) {
          while (1) switch (_context280.n) {
            case 0:
              _context280.n = 1;
              return _this185.getUser();
            case 1:
              _yield$_this185$getUs = _context280.v;
              e = _yield$_this185$getUs.data.user;
              t = _yield$_this185$getUs.error;
              if (!t) {
                _context280.n = 2;
                break;
              }
              return _context280.a(2, {
                data: null,
                error: t
              });
            case 2:
              n = {
                all: [],
                phone: [],
                totp: [],
                webauthn: []
              };
              _iterator5 = _createForOfIteratorHelper((_e$factors = e === null || e === void 0 ? void 0 : e.factors) !== null && _e$factors !== void 0 ? _e$factors : []);
              try {
                for (_iterator5.s(); !(_step5 = _iterator5.n()).done;) {
                  _t227 = _step5.value;
                  n.all.push(_t227), _t227.status === `verified` && n[_t227.factor_type].push(_t227);
                }
              } catch (err) {
                _iterator5.e(err);
              } finally {
                _iterator5.f();
              }
              return _context280.a(2, {
                data: n,
                error: null
              });
          }
        }, _callee279);
      }))();
    }
    _getAuthenticatorAssuranceLevel(e) {
      var _this186 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee280() {
        var _t$user$factors$filte, _t$user$factors;
        var _i21$factors$filter, _i21$factors, _dr2, _t228, _n29, _r22, _yield$_this186$getUs, _i21, _a4, _o2, _yield$_this186$getSe, t, n, _dr3, r, i, a, o, _t229;
        return _regenerator().w(function (_context281) {
          while (1) switch (_context281.p = _context281.n) {
            case 0:
              if (!e) {
                _context281.n = 6;
                break;
              }
              _context281.p = 1;
              _dr2 = dr(e), _t228 = _dr2.payload, _n29 = null;
              _t228.aal && (_n29 = _t228.aal);
              _r22 = _n29;
              _context281.n = 2;
              return _this186.getUser(e);
            case 2:
              _yield$_this186$getUs = _context281.v;
              _i21 = _yield$_this186$getUs.data.user;
              _a4 = _yield$_this186$getUs.error;
              if (!_a4) {
                _context281.n = 3;
                break;
              }
              return _context281.a(2, _this186._returnResult({
                data: null,
                error: _a4
              }));
            case 3:
              ((_i21$factors$filter = _i21 === null || _i21 === void 0 || (_i21$factors = _i21.factors) === null || _i21$factors === void 0 ? void 0 : _i21$factors.filter(e => e.status === `verified`)) !== null && _i21$factors$filter !== void 0 ? _i21$factors$filter : []).length > 0 && (_r22 = `aal2`);
              _o2 = _t228.amr || [];
              return _context281.a(2, {
                data: {
                  currentLevel: _n29,
                  nextLevel: _r22,
                  currentAuthenticationMethods: _o2
                },
                error: null
              });
            case 4:
              _context281.p = 4;
              _t229 = _context281.v;
              if (!P(_t229)) {
                _context281.n = 5;
                break;
              }
              return _context281.a(2, _this186._returnResult({
                data: null,
                error: _t229
              }));
            case 5:
              throw _t229;
            case 6:
              _context281.n = 7;
              return _this186.getSession();
            case 7:
              _yield$_this186$getSe = _context281.v;
              t = _yield$_this186$getSe.data.session;
              n = _yield$_this186$getSe.error;
              if (!n) {
                _context281.n = 8;
                break;
              }
              return _context281.a(2, _this186._returnResult({
                data: null,
                error: n
              }));
            case 8:
              if (t) {
                _context281.n = 9;
                break;
              }
              return _context281.a(2, {
                data: {
                  currentLevel: null,
                  nextLevel: null,
                  currentAuthenticationMethods: []
                },
                error: null
              });
            case 9:
              _dr3 = dr(t.access_token), r = _dr3.payload, i = null;
              r.aal && (i = r.aal);
              a = i;
              ((_t$user$factors$filte = (_t$user$factors = t.user.factors) === null || _t$user$factors === void 0 ? void 0 : _t$user$factors.filter(e => e.status === `verified`)) !== null && _t$user$factors$filte !== void 0 ? _t$user$factors$filte : []).length > 0 && (a = `aal2`);
              o = r.amr || [];
              return _context281.a(2, {
                data: {
                  currentLevel: i,
                  nextLevel: a,
                  currentAuthenticationMethods: o
                },
                error: null
              });
          }
        }, _callee280, null, [[1, 4]]);
      }))();
    }
    _getAuthorizationDetails(e) {
      var _this187 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee282() {
        var _t232;
        return _regenerator().w(function (_context283) {
          while (1) switch (_context283.p = _context283.n) {
            case 0:
              _context283.p = 0;
              _context283.n = 1;
              return _this187._useSession(/*#__PURE__*/function () {
                var _ref86 = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee281(t) {
                  var n, r, _t230, _t231;
                  return _regenerator().w(function (_context282) {
                    while (1) switch (_context282.n) {
                      case 0:
                        n = t.data.session, r = t.error;
                        if (!r) {
                          _context282.n = 1;
                          break;
                        }
                        _t230 = _this187._returnResult({
                          data: null,
                          error: r
                        });
                        _context282.n = 5;
                        break;
                      case 1:
                        if (!n) {
                          _context282.n = 3;
                          break;
                        }
                        _context282.n = 2;
                        return Y(_this187.fetch, `GET`, `${_this187.url}/oauth/authorizations/${e}`, {
                          headers: _this187.headers,
                          jwt: n.access_token,
                          xform: e => ({
                            data: e,
                            error: null
                          })
                        });
                      case 2:
                        _t231 = _context282.v;
                        _context282.n = 4;
                        break;
                      case 3:
                        _t231 = _this187._returnResult({
                          data: null,
                          error: new L()
                        });
                      case 4:
                        _t230 = _t231;
                      case 5:
                        return _context282.a(2, _t230);
                    }
                  }, _callee281);
                }));
                return function (_x113) {
                  return _ref86.apply(this, arguments);
                };
              }());
            case 1:
              return _context283.a(2, _context283.v);
            case 2:
              _context283.p = 2;
              _t232 = _context283.v;
              if (!P(_t232)) {
                _context283.n = 3;
                break;
              }
              return _context283.a(2, _this187._returnResult({
                data: null,
                error: _t232
              }));
            case 3:
              throw _t232;
            case 4:
              return _context283.a(2);
          }
        }, _callee282, null, [[0, 2]]);
      }))();
    }
    _approveAuthorization(e, t) {
      var _this188 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee284() {
        var _t233;
        return _regenerator().w(function (_context285) {
          while (1) switch (_context285.p = _context285.n) {
            case 0:
              _context285.p = 0;
              _context285.n = 1;
              return _this188._useSession(/*#__PURE__*/function () {
                var _ref87 = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee283(n) {
                  var r, i, a;
                  return _regenerator().w(function (_context284) {
                    while (1) switch (_context284.n) {
                      case 0:
                        r = n.data.session, i = n.error;
                        if (!i) {
                          _context284.n = 1;
                          break;
                        }
                        return _context284.a(2, _this188._returnResult({
                          data: null,
                          error: i
                        }));
                      case 1:
                        if (r) {
                          _context284.n = 2;
                          break;
                        }
                        return _context284.a(2, _this188._returnResult({
                          data: null,
                          error: new L()
                        }));
                      case 2:
                        _context284.n = 3;
                        return Y(_this188.fetch, `POST`, `${_this188.url}/oauth/authorizations/${e}/consent`, {
                          headers: _this188.headers,
                          jwt: r.access_token,
                          body: {
                            action: `approve`
                          },
                          xform: e => ({
                            data: e,
                            error: null
                          })
                        });
                      case 3:
                        a = _context284.v;
                        return _context284.a(2, (a.data && a.data.redirect_url && V() && !(t !== null && t !== void 0 && t.skipBrowserRedirect) && window.location.assign(a.data.redirect_url), a));
                    }
                  }, _callee283);
                }));
                return function (_x114) {
                  return _ref87.apply(this, arguments);
                };
              }());
            case 1:
              return _context285.a(2, _context285.v);
            case 2:
              _context285.p = 2;
              _t233 = _context285.v;
              if (!P(_t233)) {
                _context285.n = 3;
                break;
              }
              return _context285.a(2, _this188._returnResult({
                data: null,
                error: _t233
              }));
            case 3:
              throw _t233;
            case 4:
              return _context285.a(2);
          }
        }, _callee284, null, [[0, 2]]);
      }))();
    }
    _denyAuthorization(e, t) {
      var _this189 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee286() {
        var _t234;
        return _regenerator().w(function (_context287) {
          while (1) switch (_context287.p = _context287.n) {
            case 0:
              _context287.p = 0;
              _context287.n = 1;
              return _this189._useSession(/*#__PURE__*/function () {
                var _ref88 = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee285(n) {
                  var r, i, a;
                  return _regenerator().w(function (_context286) {
                    while (1) switch (_context286.n) {
                      case 0:
                        r = n.data.session, i = n.error;
                        if (!i) {
                          _context286.n = 1;
                          break;
                        }
                        return _context286.a(2, _this189._returnResult({
                          data: null,
                          error: i
                        }));
                      case 1:
                        if (r) {
                          _context286.n = 2;
                          break;
                        }
                        return _context286.a(2, _this189._returnResult({
                          data: null,
                          error: new L()
                        }));
                      case 2:
                        _context286.n = 3;
                        return Y(_this189.fetch, `POST`, `${_this189.url}/oauth/authorizations/${e}/consent`, {
                          headers: _this189.headers,
                          jwt: r.access_token,
                          body: {
                            action: `deny`
                          },
                          xform: e => ({
                            data: e,
                            error: null
                          })
                        });
                      case 3:
                        a = _context286.v;
                        return _context286.a(2, (a.data && a.data.redirect_url && V() && !(t !== null && t !== void 0 && t.skipBrowserRedirect) && window.location.assign(a.data.redirect_url), a));
                    }
                  }, _callee285);
                }));
                return function (_x115) {
                  return _ref88.apply(this, arguments);
                };
              }());
            case 1:
              return _context287.a(2, _context287.v);
            case 2:
              _context287.p = 2;
              _t234 = _context287.v;
              if (!P(_t234)) {
                _context287.n = 3;
                break;
              }
              return _context287.a(2, _this189._returnResult({
                data: null,
                error: _t234
              }));
            case 3:
              throw _t234;
            case 4:
              return _context287.a(2);
          }
        }, _callee286, null, [[0, 2]]);
      }))();
    }
    _listOAuthGrants() {
      var _this190 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee288() {
        var _t237;
        return _regenerator().w(function (_context289) {
          while (1) switch (_context289.p = _context289.n) {
            case 0:
              _context289.p = 0;
              _context289.n = 1;
              return _this190._useSession(/*#__PURE__*/function () {
                var _ref89 = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee287(e) {
                  var t, n, _t235, _t236;
                  return _regenerator().w(function (_context288) {
                    while (1) switch (_context288.n) {
                      case 0:
                        t = e.data.session, n = e.error;
                        if (!n) {
                          _context288.n = 1;
                          break;
                        }
                        _t235 = _this190._returnResult({
                          data: null,
                          error: n
                        });
                        _context288.n = 5;
                        break;
                      case 1:
                        if (!t) {
                          _context288.n = 3;
                          break;
                        }
                        _context288.n = 2;
                        return Y(_this190.fetch, `GET`, `${_this190.url}/user/oauth/grants`, {
                          headers: _this190.headers,
                          jwt: t.access_token,
                          xform: e => ({
                            data: e,
                            error: null
                          })
                        });
                      case 2:
                        _t236 = _context288.v;
                        _context288.n = 4;
                        break;
                      case 3:
                        _t236 = _this190._returnResult({
                          data: null,
                          error: new L()
                        });
                      case 4:
                        _t235 = _t236;
                      case 5:
                        return _context288.a(2, _t235);
                    }
                  }, _callee287);
                }));
                return function (_x116) {
                  return _ref89.apply(this, arguments);
                };
              }());
            case 1:
              return _context289.a(2, _context289.v);
            case 2:
              _context289.p = 2;
              _t237 = _context289.v;
              if (!P(_t237)) {
                _context289.n = 3;
                break;
              }
              return _context289.a(2, _this190._returnResult({
                data: null,
                error: _t237
              }));
            case 3:
              throw _t237;
            case 4:
              return _context289.a(2);
          }
        }, _callee288, null, [[0, 2]]);
      }))();
    }
    _revokeOAuthGrant(e) {
      var _this191 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee290() {
        var _t240;
        return _regenerator().w(function (_context291) {
          while (1) switch (_context291.p = _context291.n) {
            case 0:
              _context291.p = 0;
              _context291.n = 1;
              return _this191._useSession(/*#__PURE__*/function () {
                var _ref90 = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee289(t) {
                  var n, r, _t238, _t239;
                  return _regenerator().w(function (_context290) {
                    while (1) switch (_context290.n) {
                      case 0:
                        n = t.data.session, r = t.error;
                        if (!r) {
                          _context290.n = 1;
                          break;
                        }
                        _t238 = _this191._returnResult({
                          data: null,
                          error: r
                        });
                        _context290.n = 5;
                        break;
                      case 1:
                        if (!n) {
                          _context290.n = 3;
                          break;
                        }
                        _context290.n = 2;
                        return Y(_this191.fetch, `DELETE`, `${_this191.url}/user/oauth/grants`, {
                          headers: _this191.headers,
                          jwt: n.access_token,
                          query: {
                            client_id: e.clientId
                          },
                          noResolveJson: !0
                        });
                      case 2:
                        _t239 = {
                          data: {},
                          error: null
                        };
                        _context290.n = 4;
                        break;
                      case 3:
                        _t239 = _this191._returnResult({
                          data: null,
                          error: new L()
                        });
                      case 4:
                        _t238 = _t239;
                      case 5:
                        return _context290.a(2, _t238);
                    }
                  }, _callee289);
                }));
                return function (_x117) {
                  return _ref90.apply(this, arguments);
                };
              }());
            case 1:
              return _context291.a(2, _context291.v);
            case 2:
              _context291.p = 2;
              _t240 = _context291.v;
              if (!P(_t240)) {
                _context291.n = 3;
                break;
              }
              return _context291.a(2, _this191._returnResult({
                data: null,
                error: _t240
              }));
            case 3:
              throw _t240;
            case 4:
              return _context291.a(2);
          }
        }, _callee290, null, [[0, 2]]);
      }))();
    }
    fetchJwk(_x118) {
      var _this192 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee291(e, t = {
        keys: []
      }) {
        var n, r, _yield$Y15, i, a;
        return _regenerator().w(function (_context292) {
          while (1) switch (_context292.n) {
            case 0:
              n = t.keys.find(t => t.kid === e);
              if (!n) {
                _context292.n = 1;
                break;
              }
              return _context292.a(2, n);
            case 1:
              r = Date.now();
              if (!(n = _this192.jwks.keys.find(t => t.kid === e), n && _this192.jwks_cached_at + 6e5 > r)) {
                _context292.n = 2;
                break;
              }
              return _context292.a(2, n);
            case 2:
              _context292.n = 3;
              return Y(_this192.fetch, `GET`, `${_this192.url}/.well-known/jwks.json`, {
                headers: _this192.headers
              });
            case 3:
              _yield$Y15 = _context292.v;
              i = _yield$Y15.data;
              a = _yield$Y15.error;
              if (!a) {
                _context292.n = 4;
                break;
              }
              throw a;
            case 4:
              return _context292.a(2, !i.keys || i.keys.length === 0 || (_this192.jwks = i, _this192.jwks_cached_at = r, n = i.keys.find(t => t.kid === e), !n) ? null : n);
          }
        }, _callee291);
      })).apply(this, arguments);
    }
    getClaims(_x119) {
      var _this193 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee292(e, t = {}) {
        var n, _yield$_this193$getSe, _e67, _t241, _dr4, r, i, a, _dr4$raw, o, s, c, _yield$_this193$getUs, _e68, _l6, _u6, _t242, _t243, _t244;
        return _regenerator().w(function (_context293) {
          while (1) switch (_context293.p = _context293.n) {
            case 0:
              _context293.p = 0;
              n = e;
              if (n) {
                _context293.n = 3;
                break;
              }
              _context293.n = 1;
              return _this193.getSession();
            case 1:
              _yield$_this193$getSe = _context293.v;
              _e67 = _yield$_this193$getSe.data;
              _t241 = _yield$_this193$getSe.error;
              if (!(_t241 || !_e67.session)) {
                _context293.n = 2;
                break;
              }
              return _context293.a(2, _this193._returnResult({
                data: null,
                error: _t241
              }));
            case 2:
              n = _e67.session.access_token;
            case 3:
              _dr4 = dr(n), r = _dr4.header, i = _dr4.payload, a = _dr4.signature, _dr4$raw = _dr4.raw, o = _dr4$raw.header, s = _dr4$raw.payload;
              if (t !== null && t !== void 0 && t.allowExpired) {
                _context293.n = 6;
                break;
              }
              _context293.p = 4;
              br(i.exp);
              _context293.n = 6;
              break;
            case 5:
              _context293.p = 5;
              _t242 = _context293.v;
              throw new Kn(_t242 instanceof Error ? _t242.message : `JWT validation failed`);
            case 6:
              if (!(!r.alg || r.alg.startsWith(`HS`) || !r.kid || !(`crypto` in globalThis && `subtle` in globalThis.crypto))) {
                _context293.n = 7;
                break;
              }
              _t243 = null;
              _context293.n = 9;
              break;
            case 7:
              _context293.n = 8;
              return _this193.fetchJwk(r.kid, t !== null && t !== void 0 && t.keys ? {
                keys: t.keys
              } : t === null || t === void 0 ? void 0 : t.jwks);
            case 8:
              _t243 = _context293.v;
            case 9:
              c = _t243;
              if (c) {
                _context293.n = 12;
                break;
              }
              _context293.n = 10;
              return _this193.getUser(n);
            case 10:
              _yield$_this193$getUs = _context293.v;
              _e68 = _yield$_this193$getUs.error;
              if (!_e68) {
                _context293.n = 11;
                break;
              }
              throw _e68;
            case 11:
              return _context293.a(2, {
                data: {
                  claims: i,
                  header: r,
                  signature: a
                },
                error: null
              });
            case 12:
              _l6 = xr(r.alg);
              _context293.n = 13;
              return crypto.subtle.importKey(`jwk`, c, _l6, !0, [`verify`]);
            case 13:
              _u6 = _context293.v;
              _context293.n = 14;
              return crypto.subtle.verify(_l6, _u6, a, nr(`${o}.${s}`));
            case 14:
              if (_context293.v) {
                _context293.n = 15;
                break;
              }
              throw new Kn(`Invalid JWT signature`);
            case 15:
              return _context293.a(2, {
                data: {
                  claims: i,
                  header: r,
                  signature: a
                },
                error: null
              });
            case 16:
              _context293.p = 16;
              _t244 = _context293.v;
              if (!P(_t244)) {
                _context293.n = 17;
                break;
              }
              return _context293.a(2, _this193._returnResult({
                data: null,
                error: _t244
              }));
            case 17:
              throw _t244;
            case 18:
              return _context293.a(2);
          }
        }, _callee292, null, [[4, 5], [0, 16]]);
      })).apply(this, arguments);
    }
    signInWithPasskey(e) {
      var _this194 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee293() {
        var _e$options18, _e$options$signal, _e$options19, _yield$_this194$_star, _t245, n, _yield$oi2, r, i, a, _t246;
        return _regenerator().w(function (_context294) {
          while (1) switch (_context294.p = _context294.n) {
            case 0:
              q(_this194.experimental);
              _context294.p = 1;
              if (ii()) {
                _context294.n = 2;
                break;
              }
              return _context294.a(2, _this194._returnResult({
                data: null,
                error: new F(`Browser does not support WebAuthn`, null)
              }));
            case 2:
              _context294.n = 3;
              return _this194._startPasskeyAuthentication({
                options: {
                  captchaToken: e === null || e === void 0 || (_e$options18 = e.options) === null || _e$options18 === void 0 ? void 0 : _e$options18.captchaToken
                }
              });
            case 3:
              _yield$_this194$_star = _context294.v;
              _t245 = _yield$_this194$_star.data;
              n = _yield$_this194$_star.error;
              if (!(n || !_t245)) {
                _context294.n = 4;
                break;
              }
              return _context294.a(2, _this194._returnResult({
                data: null,
                error: n
              }));
            case 4:
              _context294.n = 5;
              return oi({
                publicKey: ei(_t245.options),
                signal: (_e$options$signal = e === null || e === void 0 || (_e$options19 = e.options) === null || _e$options19 === void 0 ? void 0 : _e$options19.signal) !== null && _e$options$signal !== void 0 ? _e$options$signal : Qr.createNewAbortSignal()
              });
            case 5:
              _yield$oi2 = _context294.v;
              r = _yield$oi2.data;
              i = _yield$oi2.error;
              if (!(i || !r)) {
                _context294.n = 6;
                break;
              }
              return _context294.a(2, _this194._returnResult({
                data: null,
                error: i !== null && i !== void 0 ? i : new F(`WebAuthn ceremony failed`, null)
              }));
            case 6:
              a = ni(r);
              return _context294.a(2, _this194._verifyPasskeyAuthentication({
                challengeId: _t245.challenge_id,
                credential: a
              }));
            case 7:
              _context294.p = 7;
              _t246 = _context294.v;
              if (!P(_t246)) {
                _context294.n = 8;
                break;
              }
              return _context294.a(2, _this194._returnResult({
                data: null,
                error: _t246
              }));
            case 8:
              throw _t246;
            case 9:
              return _context294.a(2);
          }
        }, _callee293, null, [[1, 7]]);
      }))();
    }
    registerPasskey(e) {
      var _this195 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee294() {
        var _e$options$signal2, _e$options20, _yield$_this195$_star, _t247, n, _yield$ai2, r, i, a, _t248;
        return _regenerator().w(function (_context295) {
          while (1) switch (_context295.p = _context295.n) {
            case 0:
              q(_this195.experimental);
              _context295.p = 1;
              if (ii()) {
                _context295.n = 2;
                break;
              }
              return _context295.a(2, _this195._returnResult({
                data: null,
                error: new F(`Browser does not support WebAuthn`, null)
              }));
            case 2:
              _context295.n = 3;
              return _this195._startPasskeyRegistration();
            case 3:
              _yield$_this195$_star = _context295.v;
              _t247 = _yield$_this195$_star.data;
              n = _yield$_this195$_star.error;
              if (!(n || !_t247)) {
                _context295.n = 4;
                break;
              }
              return _context295.a(2, _this195._returnResult({
                data: null,
                error: n
              }));
            case 4:
              _context295.n = 5;
              return ai({
                publicKey: $r(_t247.options),
                signal: (_e$options$signal2 = e === null || e === void 0 || (_e$options20 = e.options) === null || _e$options20 === void 0 ? void 0 : _e$options20.signal) !== null && _e$options$signal2 !== void 0 ? _e$options$signal2 : Qr.createNewAbortSignal()
              });
            case 5:
              _yield$ai2 = _context295.v;
              r = _yield$ai2.data;
              i = _yield$ai2.error;
              if (!(i || !r)) {
                _context295.n = 6;
                break;
              }
              return _context295.a(2, _this195._returnResult({
                data: null,
                error: i !== null && i !== void 0 ? i : new F(`WebAuthn ceremony failed`, null)
              }));
            case 6:
              a = ti(r);
              return _context295.a(2, _this195._verifyPasskeyRegistration({
                challengeId: _t247.challenge_id,
                credential: a
              }));
            case 7:
              _context295.p = 7;
              _t248 = _context295.v;
              if (!P(_t248)) {
                _context295.n = 8;
                break;
              }
              return _context295.a(2, _this195._returnResult({
                data: null,
                error: _t248
              }));
            case 8:
              throw _t248;
            case 9:
              return _context295.a(2);
          }
        }, _callee294, null, [[1, 7]]);
      }))();
    }
    _startPasskeyRegistration() {
      var _this196 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee296() {
        var _t249;
        return _regenerator().w(function (_context297) {
          while (1) switch (_context297.p = _context297.n) {
            case 0:
              q(_this196.experimental);
              _context297.p = 1;
              _context297.n = 2;
              return _this196._useSession(/*#__PURE__*/function () {
                var _ref91 = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee295(e) {
                  var t, n, _yield$Y16, r, i;
                  return _regenerator().w(function (_context296) {
                    while (1) switch (_context296.n) {
                      case 0:
                        t = e.data.session, n = e.error;
                        if (!n) {
                          _context296.n = 1;
                          break;
                        }
                        return _context296.a(2, _this196._returnResult({
                          data: null,
                          error: n
                        }));
                      case 1:
                        if (t) {
                          _context296.n = 2;
                          break;
                        }
                        return _context296.a(2, _this196._returnResult({
                          data: null,
                          error: new L()
                        }));
                      case 2:
                        _context296.n = 3;
                        return Y(_this196.fetch, `POST`, `${_this196.url}/passkeys/registration/options`, {
                          headers: _this196.headers,
                          jwt: t.access_token,
                          body: {}
                        });
                      case 3:
                        _yield$Y16 = _context296.v;
                        r = _yield$Y16.data;
                        i = _yield$Y16.error;
                        return _context296.a(2, i ? _this196._returnResult({
                          data: null,
                          error: i
                        }) : _this196._returnResult({
                          data: r,
                          error: null
                        }));
                    }
                  }, _callee295);
                }));
                return function (_x120) {
                  return _ref91.apply(this, arguments);
                };
              }());
            case 2:
              return _context297.a(2, _context297.v);
            case 3:
              _context297.p = 3;
              _t249 = _context297.v;
              if (!P(_t249)) {
                _context297.n = 4;
                break;
              }
              return _context297.a(2, _this196._returnResult({
                data: null,
                error: _t249
              }));
            case 4:
              throw _t249;
            case 5:
              return _context297.a(2);
          }
        }, _callee296, null, [[1, 3]]);
      }))();
    }
    _verifyPasskeyRegistration(e) {
      var _this197 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee298() {
        var _t250;
        return _regenerator().w(function (_context299) {
          while (1) switch (_context299.p = _context299.n) {
            case 0:
              q(_this197.experimental);
              _context299.p = 1;
              _context299.n = 2;
              return _this197._useSession(/*#__PURE__*/function () {
                var _ref92 = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee297(t) {
                  var n, r, _yield$Y17, i, a;
                  return _regenerator().w(function (_context298) {
                    while (1) switch (_context298.n) {
                      case 0:
                        n = t.data.session, r = t.error;
                        if (!r) {
                          _context298.n = 1;
                          break;
                        }
                        return _context298.a(2, _this197._returnResult({
                          data: null,
                          error: r
                        }));
                      case 1:
                        if (n) {
                          _context298.n = 2;
                          break;
                        }
                        return _context298.a(2, _this197._returnResult({
                          data: null,
                          error: new L()
                        }));
                      case 2:
                        _context298.n = 3;
                        return Y(_this197.fetch, `POST`, `${_this197.url}/passkeys/registration/verify`, {
                          headers: _this197.headers,
                          jwt: n.access_token,
                          body: {
                            challenge_id: e.challengeId,
                            credential: e.credential
                          }
                        });
                      case 3:
                        _yield$Y17 = _context298.v;
                        i = _yield$Y17.data;
                        a = _yield$Y17.error;
                        return _context298.a(2, a ? _this197._returnResult({
                          data: null,
                          error: a
                        }) : _this197._returnResult({
                          data: i,
                          error: null
                        }));
                    }
                  }, _callee297);
                }));
                return function (_x121) {
                  return _ref92.apply(this, arguments);
                };
              }());
            case 2:
              return _context299.a(2, _context299.v);
            case 3:
              _context299.p = 3;
              _t250 = _context299.v;
              if (!P(_t250)) {
                _context299.n = 4;
                break;
              }
              return _context299.a(2, _this197._returnResult({
                data: null,
                error: _t250
              }));
            case 4:
              throw _t250;
            case 5:
              return _context299.a(2);
          }
        }, _callee298, null, [[1, 3]]);
      }))();
    }
    _startPasskeyAuthentication(e) {
      var _this198 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee299() {
        var _e$options21, _yield$Y18, _t251, n, _t252;
        return _regenerator().w(function (_context300) {
          while (1) switch (_context300.p = _context300.n) {
            case 0:
              q(_this198.experimental);
              _context300.p = 1;
              _context300.n = 2;
              return Y(_this198.fetch, `POST`, `${_this198.url}/passkeys/authentication/options`, {
                headers: _this198.headers,
                body: {
                  gotrue_meta_security: {
                    captcha_token: e === null || e === void 0 || (_e$options21 = e.options) === null || _e$options21 === void 0 ? void 0 : _e$options21.captchaToken
                  }
                }
              });
            case 2:
              _yield$Y18 = _context300.v;
              _t251 = _yield$Y18.data;
              n = _yield$Y18.error;
              return _context300.a(2, n ? _this198._returnResult({
                data: null,
                error: n
              }) : _this198._returnResult({
                data: _t251,
                error: null
              }));
            case 3:
              _context300.p = 3;
              _t252 = _context300.v;
              if (!P(_t252)) {
                _context300.n = 4;
                break;
              }
              return _context300.a(2, _this198._returnResult({
                data: null,
                error: _t252
              }));
            case 4:
              throw _t252;
            case 5:
              return _context300.a(2);
          }
        }, _callee299, null, [[1, 3]]);
      }))();
    }
    _verifyPasskeyAuthentication(e) {
      var _this199 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee300() {
        var _yield$Y19, _t253, n, _t254, _t255, _t256;
        return _regenerator().w(function (_context301) {
          while (1) switch (_context301.p = _context301.n) {
            case 0:
              q(_this199.experimental);
              _context301.p = 1;
              _context301.n = 2;
              return Y(_this199.fetch, `POST`, `${_this199.url}/passkeys/authentication/verify`, {
                headers: _this199.headers,
                body: {
                  challenge_id: e.challengeId,
                  credential: e.credential
                },
                xform: X
              });
            case 2:
              _yield$Y19 = _context301.v;
              _t253 = _yield$Y19.data;
              n = _yield$Y19.error;
              if (!n) {
                _context301.n = 3;
                break;
              }
              _t254 = _this199._returnResult({
                data: null,
                error: n
              });
              _context301.n = 6;
              break;
            case 3:
              _t255 = _t253.session;
              if (!_t255) {
                _context301.n = 5;
                break;
              }
              _context301.n = 4;
              return _this199._saveSession(_t253.session);
            case 4:
              _context301.n = 5;
              return _this199._notifyAllSubscribers(`SIGNED_IN`, _t253.session);
            case 5:
              _t254 = _this199._returnResult({
                data: _t253,
                error: null
              });
            case 6:
              return _context301.a(2, _t254);
            case 7:
              _context301.p = 7;
              _t256 = _context301.v;
              if (!P(_t256)) {
                _context301.n = 8;
                break;
              }
              return _context301.a(2, _this199._returnResult({
                data: null,
                error: _t256
              }));
            case 8:
              throw _t256;
            case 9:
              return _context301.a(2);
          }
        }, _callee300, null, [[1, 7]]);
      }))();
    }
    _listPasskeys() {
      var _this200 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee302() {
        var _t257;
        return _regenerator().w(function (_context303) {
          while (1) switch (_context303.p = _context303.n) {
            case 0:
              q(_this200.experimental);
              _context303.p = 1;
              _context303.n = 2;
              return _this200._useSession(/*#__PURE__*/function () {
                var _ref93 = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee301(e) {
                  var t, n, _yield$Y20, r, i;
                  return _regenerator().w(function (_context302) {
                    while (1) switch (_context302.n) {
                      case 0:
                        t = e.data.session, n = e.error;
                        if (!n) {
                          _context302.n = 1;
                          break;
                        }
                        return _context302.a(2, _this200._returnResult({
                          data: null,
                          error: n
                        }));
                      case 1:
                        if (t) {
                          _context302.n = 2;
                          break;
                        }
                        return _context302.a(2, _this200._returnResult({
                          data: null,
                          error: new L()
                        }));
                      case 2:
                        _context302.n = 3;
                        return Y(_this200.fetch, `GET`, `${_this200.url}/passkeys`, {
                          headers: _this200.headers,
                          jwt: t.access_token,
                          xform: e => ({
                            data: e,
                            error: null
                          })
                        });
                      case 3:
                        _yield$Y20 = _context302.v;
                        r = _yield$Y20.data;
                        i = _yield$Y20.error;
                        return _context302.a(2, i ? _this200._returnResult({
                          data: null,
                          error: i
                        }) : _this200._returnResult({
                          data: r,
                          error: null
                        }));
                    }
                  }, _callee301);
                }));
                return function (_x122) {
                  return _ref93.apply(this, arguments);
                };
              }());
            case 2:
              return _context303.a(2, _context303.v);
            case 3:
              _context303.p = 3;
              _t257 = _context303.v;
              if (!P(_t257)) {
                _context303.n = 4;
                break;
              }
              return _context303.a(2, _this200._returnResult({
                data: null,
                error: _t257
              }));
            case 4:
              throw _t257;
            case 5:
              return _context303.a(2);
          }
        }, _callee302, null, [[1, 3]]);
      }))();
    }
    _updatePasskey(e) {
      var _this201 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee304() {
        var _t258;
        return _regenerator().w(function (_context305) {
          while (1) switch (_context305.p = _context305.n) {
            case 0:
              q(_this201.experimental);
              _context305.p = 1;
              _context305.n = 2;
              return _this201._useSession(/*#__PURE__*/function () {
                var _ref94 = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee303(t) {
                  var n, r, _yield$Y21, i, a;
                  return _regenerator().w(function (_context304) {
                    while (1) switch (_context304.n) {
                      case 0:
                        n = t.data.session, r = t.error;
                        if (!r) {
                          _context304.n = 1;
                          break;
                        }
                        return _context304.a(2, _this201._returnResult({
                          data: null,
                          error: r
                        }));
                      case 1:
                        if (n) {
                          _context304.n = 2;
                          break;
                        }
                        return _context304.a(2, _this201._returnResult({
                          data: null,
                          error: new L()
                        }));
                      case 2:
                        _context304.n = 3;
                        return Y(_this201.fetch, `PATCH`, `${_this201.url}/passkeys/${e.passkeyId}`, {
                          headers: _this201.headers,
                          jwt: n.access_token,
                          body: {
                            friendly_name: e.friendlyName
                          }
                        });
                      case 3:
                        _yield$Y21 = _context304.v;
                        i = _yield$Y21.data;
                        a = _yield$Y21.error;
                        return _context304.a(2, a ? _this201._returnResult({
                          data: null,
                          error: a
                        }) : _this201._returnResult({
                          data: i,
                          error: null
                        }));
                    }
                  }, _callee303);
                }));
                return function (_x123) {
                  return _ref94.apply(this, arguments);
                };
              }());
            case 2:
              return _context305.a(2, _context305.v);
            case 3:
              _context305.p = 3;
              _t258 = _context305.v;
              if (!P(_t258)) {
                _context305.n = 4;
                break;
              }
              return _context305.a(2, _this201._returnResult({
                data: null,
                error: _t258
              }));
            case 4:
              throw _t258;
            case 5:
              return _context305.a(2);
          }
        }, _callee304, null, [[1, 3]]);
      }))();
    }
    _deletePasskey(e) {
      var _this202 = this;
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee306() {
        var _t259;
        return _regenerator().w(function (_context307) {
          while (1) switch (_context307.p = _context307.n) {
            case 0:
              q(_this202.experimental);
              _context307.p = 1;
              _context307.n = 2;
              return _this202._useSession(/*#__PURE__*/function () {
                var _ref95 = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee305(t) {
                  var n, r, _yield$Y22, i;
                  return _regenerator().w(function (_context306) {
                    while (1) switch (_context306.n) {
                      case 0:
                        n = t.data.session, r = t.error;
                        if (!r) {
                          _context306.n = 1;
                          break;
                        }
                        return _context306.a(2, _this202._returnResult({
                          data: null,
                          error: r
                        }));
                      case 1:
                        if (n) {
                          _context306.n = 2;
                          break;
                        }
                        return _context306.a(2, _this202._returnResult({
                          data: null,
                          error: new L()
                        }));
                      case 2:
                        _context306.n = 3;
                        return Y(_this202.fetch, `DELETE`, `${_this202.url}/passkeys/${e.passkeyId}`, {
                          headers: _this202.headers,
                          jwt: n.access_token,
                          noResolveJson: !0
                        });
                      case 3:
                        _yield$Y22 = _context306.v;
                        i = _yield$Y22.error;
                        return _context306.a(2, i ? _this202._returnResult({
                          data: null,
                          error: i
                        }) : _this202._returnResult({
                          data: null,
                          error: null
                        }));
                    }
                  }, _callee305);
                }));
                return function (_x124) {
                  return _ref95.apply(this, arguments);
                };
              }());
            case 2:
              return _context307.a(2, _context307.v);
            case 3:
              _context307.p = 3;
              _t259 = _context307.v;
              if (!P(_t259)) {
                _context307.n = 4;
                break;
              }
              return _context307.a(2, _this202._returnResult({
                data: null,
                error: _t259
              }));
            case 4:
              throw _t259;
            case 5:
              return _context307.a(2);
          }
        }, _callee306, null, [[1, 3]]);
      }))();
    }
  };
  hi.nextInstanceID = {};
  var gi = hi,
    _i = Ir,
    vi = gi,
    yi = class extends vi {
      constructor(e) {
        super(e);
      }
    },
    bi = class {
      constructor(e, t, n) {
        var _o$auth$storageKey, _o$global$headers, _o$auth;
        this.supabaseUrl = e, this.supabaseKey = t;
        var r = wn(e);
        if (!t) throw Error(`supabaseKey is required.`);
        this.realtimeUrl = new URL(`realtime/v1`, r), this.realtimeUrl.protocol = this.realtimeUrl.protocol.replace(`http`, `ws`), this.authUrl = new URL(`auth/v1`, r), this.storageUrl = new URL(`storage/v1`, r), this.functionsUrl = new URL(`functions/v1`, r);
        var i = `sb-${r.hostname.split(`.`)[0]}-auth-token`,
          a = {
            db: on,
            realtime: cn,
            auth: _objectSpread(_objectSpread({}, sn), {}, {
              storageKey: i
            }),
            global: an,
            tracePropagation: ln
          },
          o = Cn(n !== null && n !== void 0 ? n : {}, a);
        this.settings = o, this.storageKey = (_o$auth$storageKey = o.auth.storageKey) !== null && _o$auth$storageKey !== void 0 ? _o$auth$storageKey : ``, this.headers = (_o$global$headers = o.global.headers) !== null && _o$global$headers !== void 0 ? _o$global$headers : {}, o.accessToken ? (this.accessToken = o.accessToken, this.auth = new Proxy({}, {
          get: (e, t) => {
            throw Error(`@supabase/supabase-js: Supabase Client is configured with the accessToken option, accessing supabase.auth.${String(t)} is not possible`);
          }
        })) : this.auth = this._initSupabaseAuthClient((_o$auth = o.auth) !== null && _o$auth !== void 0 ? _o$auth : {}, this.headers, o.global.fetch), this.fetch = yn(t, e, this._getAccessToken.bind(this), o.global.fetch, o.tracePropagation), this.realtime = this._initRealtimeClient(_objectSpread({
          headers: this.headers,
          accessToken: this._getAccessToken.bind(this),
          fetch: this.fetch
        }, o.realtime)), this.accessToken && Promise.resolve(this.accessToken()).then(e => this.realtime.setAuth(e)).catch(e => console.warn(`Failed to set initial Realtime auth token:`, e)), this.rest = new le(new URL(`rest/v1`, r).href, {
          headers: this.headers,
          schema: o.db.schema,
          fetch: this.fetch,
          timeout: o.db.timeout,
          urlLengthLimit: o.db.urlLengthLimit
        }), this.storage = new en(this.storageUrl.href, this.headers, this.fetch, n === null || n === void 0 ? void 0 : n.storage), o.accessToken || this._listenForAuthEvents();
      }
      get functions() {
        return new l(this.functionsUrl.href, {
          headers: this.headers,
          customFetch: this.fetch
        });
      }
      from(e) {
        return this.rest.from(e);
      }
      schema(e) {
        return this.rest.schema(e);
      }
      rpc(e, t = {}, n = {
        head: !1,
        get: !1,
        count: void 0
      }) {
        return this.rest.rpc(e, t, n);
      }
      channel(e, t = {
        config: {}
      }) {
        return this.realtime.channel(e, t);
      }
      getChannels() {
        return this.realtime.getChannels();
      }
      removeChannel(e) {
        return this.realtime.removeChannel(e);
      }
      removeAllChannels() {
        return this.realtime.removeAllChannels();
      }
      _getAccessToken() {
        var _this203 = this;
        return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee307() {
          var _e$session$access_tok, _e$session;
          var _yield$_this203$auth$, e;
          return _regenerator().w(function (_context308) {
            while (1) switch (_context308.n) {
              case 0:
                if (!_this203.accessToken) {
                  _context308.n = 2;
                  break;
                }
                _context308.n = 1;
                return _this203.accessToken();
              case 1:
                return _context308.a(2, _context308.v);
              case 2:
                _context308.n = 3;
                return _this203.auth.getSession();
              case 3:
                _yield$_this203$auth$ = _context308.v;
                e = _yield$_this203$auth$.data;
                return _context308.a(2, (_e$session$access_tok = (_e$session = e.session) === null || _e$session === void 0 ? void 0 : _e$session.access_token) !== null && _e$session$access_tok !== void 0 ? _e$session$access_tok : _this203.supabaseKey);
            }
          }, _callee307);
        }))();
      }
      _initSupabaseAuthClient({
        autoRefreshToken: e,
        persistSession: t,
        detectSessionInUrl: n,
        storage: r,
        userStorage: i,
        storageKey: a,
        flowType: o,
        lock: s,
        debug: c,
        throwOnError: l,
        experimental: u,
        lockAcquireTimeout: d,
        skipAutoInitialize: f
      }, p, m) {
        var h = {
          Authorization: `Bearer ${this.supabaseKey}`,
          apikey: `${this.supabaseKey}`
        };
        return new yi({
          url: this.authUrl.href,
          headers: _objectSpread(_objectSpread({}, h), p),
          storageKey: a,
          autoRefreshToken: e,
          persistSession: t,
          detectSessionInUrl: n,
          storage: r,
          userStorage: i,
          flowType: o,
          lock: s,
          debug: c,
          throwOnError: l,
          experimental: u,
          fetch: m,
          lockAcquireTimeout: d,
          skipAutoInitialize: f,
          hasCustomAuthorizationHeader: Object.keys(this.headers).some(e => e.toLowerCase() === `authorization`)
        });
      }
      _initRealtimeClient(e) {
        return new at(this.realtimeUrl.href, _objectSpread(_objectSpread({}, e), {}, {
          params: _objectSpread({
            apikey: this.supabaseKey
          }, e === null || e === void 0 ? void 0 : e.params)
        }));
      }
      _listenForAuthEvents() {
        return this.auth.onAuthStateChange((e, t) => {
          this._handleTokenChanged(e, `CLIENT`, t === null || t === void 0 ? void 0 : t.access_token);
        });
      }
      _handleTokenChanged(e, t, n) {
        (e === `TOKEN_REFRESHED` || e === `SIGNED_IN`) && this.changedAccessToken !== n ? (this.changedAccessToken = n, this.realtime.setAuth(n)) : e === `SIGNED_OUT` && (this.realtime.setAuth(), t == `STORAGE` && this.auth.signOut(), this.changedAccessToken = void 0);
      }
    };
  var xi = (e, t, n) => new bi(e, t, n);
  function Si() {
    if (typeof window < `u`) return !1;
    var e = globalThis.process;
    if (!e) return !1;
    var t = e.version;
    if (t == null) return !1;
    var n = t.match(/^v(\d+)\./);
    return n ? parseInt(n[1], 10) <= 18 : !1;
  }
  return Si() && console.warn(`⚠️  Node.js 18 and below are deprecated and will no longer be supported in future versions of @supabase/supabase-js. Please upgrade to Node.js 20 or later. For more information, visit: https://github.com/orgs/supabase/discussions/37217`), e.AuthAdminApi = _i, e.AuthApiError = jn, e.AuthClient = vi, e.AuthError = N, e.AuthImplicitGrantRedirectError = Fn, e.AuthInvalidCredentialsError = Pn, e.AuthInvalidJwtError = Kn, e.AuthInvalidTokenResponseError = R, e.AuthPKCECodeVerifierMissingError = Rn, e.AuthPKCEGrantCodeExchangeError = Ln, e.AuthRefreshDiscardedError = Hn, e.AuthRetryableFetchError = Bn, e.AuthSessionMissingError = L, e.AuthUnknownError = F, e.AuthWeakPasswordError = Wn, e.CustomAuthError = I, Object.defineProperty(e, `FunctionRegion`, {
    enumerable: !0,
    get: function get() {
      return c;
    }
  }), e.FunctionsError = i, e.FunctionsFetchError = a, e.FunctionsHttpError = s, e.FunctionsRelayError = o, e.GoTrueAdminApi = Ir, e.GoTrueClient = gi, e.NavigatorLockAcquireTimeoutError = zr, e.PostgrestError = p, e.REALTIME_CHANNEL_STATES = Qe, Object.defineProperty(e, `REALTIME_LISTEN_TYPES`, {
    enumerable: !0,
    get: function get() {
      return T;
    }
  }), Object.defineProperty(e, `REALTIME_POSTGRES_CHANGES_LISTEN_EVENT`, {
    enumerable: !0,
    get: function get() {
      return Ze;
    }
  }), Object.defineProperty(e, `REALTIME_PRESENCE_LISTEN_EVENTS`, {
    enumerable: !0,
    get: function get() {
      return Ke;
    }
  }), Object.defineProperty(e, `REALTIME_SUBSCRIBE_STATES`, {
    enumerable: !0,
    get: function get() {
      return E;
    }
  }), e.RealtimeChannel = $e, e.RealtimeClient = at, e.RealtimePresence = qe, e.SIGN_OUT_SCOPES = Fr, e.StorageApiError = xt, e.SupabaseClient = bi, e.WebSocketFactory = ue, e.createClient = xi, e.isAuthApiError = Mn, e.isAuthError = P, e.isAuthImplicitGrantRedirectError = In, e.isAuthPKCECodeVerifierMissingError = zn, e.isAuthRefreshDiscardedError = Un, e.isAuthRetryableFetchError = Vn, e.isAuthSessionMissingError = Nn, e.isAuthWeakPasswordError = Gn, e.lockInternals = Q, e.navigatorLock = Vr, e.processLock = Ur, e;
}({});
