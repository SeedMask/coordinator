let imports = {};
imports['__wbindgen_placeholder__'] = module.exports;
let wasm;
const { TextDecoder, TextEncoder, inspect } = require(`util`);

const heap = new Array(128).fill(undefined);

heap.push(undefined, null, true, false);

function getObject(idx) { return heap[idx]; }

let heap_next = heap.length;

function dropObject(idx) {
    if (idx < 132) return;
    heap[idx] = heap_next;
    heap_next = idx;
}

function takeObject(idx) {
    const ret = getObject(idx);
    dropObject(idx);
    return ret;
}

function addHeapObject(obj) {
    if (heap_next === heap.length) heap.push(heap.length + 1);
    const idx = heap_next;
    heap_next = heap[idx];

    heap[idx] = obj;
    return idx;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });

cachedTextDecoder.decode();

let cachedUint8Memory0 = null;

function getUint8Memory0() {
    if (cachedUint8Memory0 === null || cachedUint8Memory0.byteLength === 0) {
        cachedUint8Memory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8Memory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return cachedTextDecoder.decode(getUint8Memory0().subarray(ptr, ptr + len));
}

function debugString(val) {
    // primitive types
    const type = typeof val;
    if (type == 'number' || type == 'boolean' || val == null) {
        return  `${val}`;
    }
    if (type == 'string') {
        return `"${val}"`;
    }
    if (type == 'symbol') {
        const description = val.description;
        if (description == null) {
            return 'Symbol';
        } else {
            return `Symbol(${description})`;
        }
    }
    if (type == 'function') {
        const name = val.name;
        if (typeof name == 'string' && name.length > 0) {
            return `Function(${name})`;
        } else {
            return 'Function';
        }
    }
    // objects
    if (Array.isArray(val)) {
        const length = val.length;
        let debug = '[';
        if (length > 0) {
            debug += debugString(val[0]);
        }
        for(let i = 1; i < length; i++) {
            debug += ', ' + debugString(val[i]);
        }
        debug += ']';
        return debug;
    }
    // Test for built-in
    const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
    let className;
    if (builtInMatches.length > 1) {
        className = builtInMatches[1];
    } else {
        // Failed to match the standard '[object ClassName]'
        return toString.call(val);
    }
    if (className == 'Object') {
        // we're a user defined class or Object
        // JSON.stringify avoids problems with cycles, and is generally much
        // easier than looping through ownProperties of `val`.
        try {
            return 'Object(' + JSON.stringify(val) + ')';
        } catch (_) {
            return 'Object';
        }
    }
    // errors
    if (val instanceof Error) {
        return `${val.name}: ${val.message}\n${val.stack}`;
    }
    // TODO we could test for more things here, like `Set`s and `Map`s.
    return className;
}

let WASM_VECTOR_LEN = 0;

let cachedTextEncoder = new TextEncoder('utf-8');

const encodeString = (typeof cachedTextEncoder.encodeInto === 'function'
    ? function (arg, view) {
    return cachedTextEncoder.encodeInto(arg, view);
}
    : function (arg, view) {
    const buf = cachedTextEncoder.encode(arg);
    view.set(buf);
    return {
        read: arg.length,
        written: buf.length
    };
});

function passStringToWasm0(arg, malloc, realloc) {

    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8Memory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8Memory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }

    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8Memory0().subarray(ptr + offset, ptr + len);
        const ret = encodeString(arg, view);

        offset += ret.written;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

let cachedInt32Memory0 = null;

function getInt32Memory0() {
    if (cachedInt32Memory0 === null || cachedInt32Memory0.byteLength === 0) {
        cachedInt32Memory0 = new Int32Array(wasm.memory.buffer);
    }
    return cachedInt32Memory0;
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

let cachedFloat64Memory0 = null;

function getFloat64Memory0() {
    if (cachedFloat64Memory0 === null || cachedFloat64Memory0.byteLength === 0) {
        cachedFloat64Memory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64Memory0;
}

let cachedBigInt64Memory0 = null;

function getBigInt64Memory0() {
    if (cachedBigInt64Memory0 === null || cachedBigInt64Memory0.byteLength === 0) {
        cachedBigInt64Memory0 = new BigInt64Array(wasm.memory.buffer);
    }
    return cachedBigInt64Memory0;
}

function makeMutClosure(arg0, arg1, dtor, f) {
    const state = { a: arg0, b: arg1, cnt: 1, dtor };
    const real = (...args) => {
        // First up with a closure we increment the internal reference
        // count. This ensures that the Rust closure environment won't
        // be deallocated while we're invoking it.
        state.cnt++;
        const a = state.a;
        state.a = 0;
        try {
            return f(a, state.b, ...args);
        } finally {
            if (--state.cnt === 0) {
                wasm.__wbindgen_export_2.get(state.dtor)(a, state.b);

            } else {
                state.a = a;
            }
        }
    };
    real.original = state;

    return real;
}
function __wbg_adapter_56(arg0, arg1, arg2) {
    wasm.__wbindgen_export_3(arg0, arg1, addHeapObject(arg2));
}

function __wbg_adapter_59(arg0, arg1) {
    wasm.__wbindgen_export_4(arg0, arg1);
}

function __wbg_adapter_62(arg0, arg1, arg2) {
    wasm.__wbindgen_export_5(arg0, arg1, addHeapObject(arg2));
}

function __wbg_adapter_65(arg0, arg1, arg2) {
    wasm.__wbindgen_export_6(arg0, arg1, addHeapObject(arg2));
}

function __wbg_adapter_68(arg0, arg1) {
    wasm.__wbindgen_export_7(arg0, arg1);
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        wasm.__wbindgen_export_8(addHeapObject(e));
    }
}
function __wbg_adapter_157(arg0, arg1, arg2, arg3) {
    wasm.__wbindgen_export_10(arg0, arg1, addHeapObject(arg2), addHeapObject(arg3));
}

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
    return instance.ptr;
}

let stack_pointer = 128;

function addBorrowedObject(obj) {
    if (stack_pointer == 1) throw new Error('out of js stack');
    heap[--stack_pointer] = obj;
    return stack_pointer;
}
/**
* `signTransaction()` is a helper function to sign a transaction using a private key array or a signer array.
* @param {SignableTransaction} mtx
* @param {PrivateKey[]} signer
* @param {boolean} verify_sig
* @returns {SignableTransaction}
*/
module.exports.signTransaction = function(mtx, signer, verify_sig) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        _assertClass(mtx, SignableTransaction);
        var ptr0 = mtx.__destroy_into_raw();
        wasm.signTransaction(retptr, ptr0, addHeapObject(signer), verify_sig);
        var r0 = getInt32Memory0()[retptr / 4 + 0];
        var r1 = getInt32Memory0()[retptr / 4 + 1];
        var r2 = getInt32Memory0()[retptr / 4 + 2];
        if (r2) {
            throw takeObject(r1);
        }
        return SignableTransaction.__wrap(r0);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
};

/**
* @param {any} script_hash
* @param {PrivateKey} privkey
* @returns {string}
*/
module.exports.signScriptHash = function(script_hash, privkey) {
    let deferred2_0;
    let deferred2_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        _assertClass(privkey, PrivateKey);
        wasm.signScriptHash(retptr, addHeapObject(script_hash), privkey.__wbg_ptr);
        var r0 = getInt32Memory0()[retptr / 4 + 0];
        var r1 = getInt32Memory0()[retptr / 4 + 1];
        var r2 = getInt32Memory0()[retptr / 4 + 2];
        var r3 = getInt32Memory0()[retptr / 4 + 3];
        var ptr1 = r0;
        var len1 = r1;
        if (r3) {
            ptr1 = 0; len1 = 0;
            throw takeObject(r2);
        }
        deferred2_0 = ptr1;
        deferred2_1 = len1;
        return getStringFromWasm0(ptr1, len1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export_9(deferred2_0, deferred2_1, 1);
    }
};

/**
* @param {any} data
* @returns {string}
*/
module.exports.sha256 = function(data) {
    let deferred2_0;
    let deferred2_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.sha256(retptr, addHeapObject(data));
        var r0 = getInt32Memory0()[retptr / 4 + 0];
        var r1 = getInt32Memory0()[retptr / 4 + 1];
        var r2 = getInt32Memory0()[retptr / 4 + 2];
        var r3 = getInt32Memory0()[retptr / 4 + 3];
        var ptr1 = r0;
        var len1 = r1;
        if (r3) {
            ptr1 = 0; len1 = 0;
            throw takeObject(r2);
        }
        deferred2_0 = ptr1;
        deferred2_1 = len1;
        return getStringFromWasm0(ptr1, len1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export_9(deferred2_0, deferred2_1, 1);
    }
};

/**
* @param {any} data
* @returns {string}
*/
module.exports.sha256d = function(data) {
    let deferred2_0;
    let deferred2_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.sha256d(retptr, addHeapObject(data));
        var r0 = getInt32Memory0()[retptr / 4 + 0];
        var r1 = getInt32Memory0()[retptr / 4 + 1];
        var r2 = getInt32Memory0()[retptr / 4 + 2];
        var r3 = getInt32Memory0()[retptr / 4 + 3];
        var ptr1 = r0;
        var len1 = r1;
        if (r3) {
            ptr1 = 0; len1 = 0;
            throw takeObject(r2);
        }
        deferred2_0 = ptr1;
        deferred2_1 = len1;
        return getStringFromWasm0(ptr1, len1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export_9(deferred2_0, deferred2_1, 1);
    }
};

/**
* @param {any} data
* @param {number} byte_length
* @returns {string}
*/
module.exports.argon2sha256iv = function(data, byte_length) {
    let deferred2_0;
    let deferred2_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.argon2sha256iv(retptr, addHeapObject(data), byte_length);
        var r0 = getInt32Memory0()[retptr / 4 + 0];
        var r1 = getInt32Memory0()[retptr / 4 + 1];
        var r2 = getInt32Memory0()[retptr / 4 + 2];
        var r3 = getInt32Memory0()[retptr / 4 + 3];
        var ptr1 = r0;
        var len1 = r1;
        if (r3) {
            ptr1 = 0; len1 = 0;
            throw takeObject(r2);
        }
        deferred2_0 = ptr1;
        deferred2_1 = len1;
        return getStringFromWasm0(ptr1, len1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export_9(deferred2_0, deferred2_1, 1);
    }
};

/**
* @param {string} text
* @param {string} password
* @returns {string}
*/
module.exports.encryptXChaCha20Poly1305 = function(text, password) {
    let deferred4_0;
    let deferred4_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(text, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(password, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
        const len1 = WASM_VECTOR_LEN;
        wasm.encryptXChaCha20Poly1305(retptr, ptr0, len0, ptr1, len1);
        var r0 = getInt32Memory0()[retptr / 4 + 0];
        var r1 = getInt32Memory0()[retptr / 4 + 1];
        var r2 = getInt32Memory0()[retptr / 4 + 2];
        var r3 = getInt32Memory0()[retptr / 4 + 3];
        var ptr3 = r0;
        var len3 = r1;
        if (r3) {
            ptr3 = 0; len3 = 0;
            throw takeObject(r2);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export_9(deferred4_0, deferred4_1, 1);
    }
};

/**
* @param {string} text
* @param {string} password
* @returns {string}
*/
module.exports.decryptXChaCha20Poly1305 = function(text, password) {
    let deferred4_0;
    let deferred4_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(text, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(password, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
        const len1 = WASM_VECTOR_LEN;
        wasm.decryptXChaCha20Poly1305(retptr, ptr0, len0, ptr1, len1);
        var r0 = getInt32Memory0()[retptr / 4 + 0];
        var r1 = getInt32Memory0()[retptr / 4 + 1];
        var r2 = getInt32Memory0()[retptr / 4 + 2];
        var r3 = getInt32Memory0()[retptr / 4 + 3];
        var ptr3 = r0;
        var len3 = r1;
        if (r3) {
            ptr3 = 0; len3 = 0;
            throw takeObject(r2);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export_9(deferred4_0, deferred4_1, 1);
    }
};

/**
* @param {string} key
* @param {number} network_type
* @param {boolean | undefined} ecdsa
* @param {number | undefined} account_kind
* @returns {Address}
*/
module.exports.createAddress = function(key, network_type, ecdsa, account_kind) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(key, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
        const len0 = WASM_VECTOR_LEN;
        wasm.createAddress(retptr, ptr0, len0, network_type, isLikeNone(ecdsa) ? 0xFFFFFF : ecdsa ? 1 : 0, isLikeNone(account_kind) ? 6 : account_kind);
        var r0 = getInt32Memory0()[retptr / 4 + 0];
        var r1 = getInt32Memory0()[retptr / 4 + 1];
        var r2 = getInt32Memory0()[retptr / 4 + 2];
        if (r2) {
            throw takeObject(r1);
        }
        return Address.__wrap(r0);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
};

/**
* @param {number} minimum_signatures
* @param {Array} keys
* @param {number} network_type
* @param {boolean | undefined} ecdsa
* @param {number | undefined} account_kind
* @returns {Address}
*/
module.exports.createMultisigAddress = function(minimum_signatures, keys, network_type, ecdsa, account_kind) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.createMultisigAddress(retptr, minimum_signatures, addHeapObject(keys), network_type, isLikeNone(ecdsa) ? 0xFFFFFF : ecdsa ? 1 : 0, isLikeNone(account_kind) ? 6 : account_kind);
        var r0 = getInt32Memory0()[retptr / 4 + 0];
        var r1 = getInt32Memory0()[retptr / 4 + 1];
        var r2 = getInt32Memory0()[retptr / 4 + 2];
        if (r2) {
            throw takeObject(r1);
        }
        return Address.__wrap(r0);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
};

/**
* Create a basic transaction without any mass limit checks.
* @param {any} utxo_entry_source
* @param {any} outputs
* @param {any} change_address
* @param {bigint} priority_fee
* @param {any} payload
* @param {any} sig_op_count
* @param {any} minimum_signatures
* @returns {SignableTransaction}
*/
module.exports.createTransaction = function(utxo_entry_source, outputs, change_address, priority_fee, payload, sig_op_count, minimum_signatures) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.createTransaction(retptr, addHeapObject(utxo_entry_source), addHeapObject(outputs), addHeapObject(change_address), addHeapObject(priority_fee), addHeapObject(payload), addHeapObject(sig_op_count), addHeapObject(minimum_signatures));
        var r0 = getInt32Memory0()[retptr / 4 + 0];
        var r1 = getInt32Memory0()[retptr / 4 + 1];
        var r2 = getInt32Memory0()[retptr / 4 + 2];
        if (r2) {
            throw takeObject(r1);
        }
        return SignableTransaction.__wrap(r0);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
};

/**
* Creates a set of transactions using transaction [`Generator`].
* @param {PrivateKey[]} settings
* @returns {Promise<object>}
*/
module.exports.createTransactions = function(settings) {
    const ret = wasm.createTransactions(addHeapObject(settings));
    return takeObject(ret);
};

/**
* Creates a set of transactions using transaction [`Generator`].
* @param {PrivateKey[]} settings
* @returns {Promise<GeneratorSummary>}
*/
module.exports.estimateTransactions = function(settings) {
    const ret = wasm.estimateTransactions(addHeapObject(settings));
    return takeObject(ret);
};

/**
* Signs a message with the given private key
* @param {object} value - an object containing { message: String, privateKey: String|PrivateKey }
* @returns {String} the signature, in hex string format
*/
module.exports.signMessage = function(value) {
    let deferred2_0;
    let deferred2_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.signMessage(retptr, addHeapObject(value));
        var r0 = getInt32Memory0()[retptr / 4 + 0];
        var r1 = getInt32Memory0()[retptr / 4 + 1];
        var r2 = getInt32Memory0()[retptr / 4 + 2];
        var r3 = getInt32Memory0()[retptr / 4 + 3];
        var ptr1 = r0;
        var len1 = r1;
        if (r3) {
            ptr1 = 0; len1 = 0;
            throw takeObject(r2);
        }
        deferred2_0 = ptr1;
        deferred2_1 = len1;
        return getStringFromWasm0(ptr1, len1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export_9(deferred2_0, deferred2_1, 1);
    }
};

/**
* Verifies with a public key the signature of the given message
* @param {object} value - an object containing { message: String, signature: String, publicKey: String|PublicKey }
* @returns {bool} true if the signature can be verified with the given public key and message, false otherwise
*/
module.exports.verifyMessage = function(value) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.verifyMessage(retptr, addHeapObject(value));
        var r0 = getInt32Memory0()[retptr / 4 + 0];
        var r1 = getInt32Memory0()[retptr / 4 + 1];
        var r2 = getInt32Memory0()[retptr / 4 + 2];
        if (r2) {
            throw takeObject(r1);
        }
        return r0 !== 0;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
};

/**
* @param {any} sompi
* @returns {number}
*/
module.exports.sompiToKaspa = function(sompi) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.sompiToKaspa(retptr, addHeapObject(sompi));
        var r0 = getFloat64Memory0()[retptr / 8 + 0];
        var r2 = getInt32Memory0()[retptr / 4 + 2];
        var r3 = getInt32Memory0()[retptr / 4 + 3];
        if (r3) {
            throw takeObject(r2);
        }
        return r0;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
};

/**
* @param {number} kaspa
* @returns {bigint}
*/
module.exports.kaspaToSompi = function(kaspa) {
    const ret = wasm.kaspaToSompi(kaspa);
    return BigInt.asUintN(64, ret);
};

/**
* @param {any} sompi
* @returns {string}
*/
module.exports.sompiToKaspaString = function(sompi) {
    let deferred2_0;
    let deferred2_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.sompiToKaspaString(retptr, addHeapObject(sompi));
        var r0 = getInt32Memory0()[retptr / 4 + 0];
        var r1 = getInt32Memory0()[retptr / 4 + 1];
        var r2 = getInt32Memory0()[retptr / 4 + 2];
        var r3 = getInt32Memory0()[retptr / 4 + 3];
        var ptr1 = r0;
        var len1 = r1;
        if (r3) {
            ptr1 = 0; len1 = 0;
            throw takeObject(r2);
        }
        deferred2_0 = ptr1;
        deferred2_1 = len1;
        return getStringFromWasm0(ptr1, len1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export_9(deferred2_0, deferred2_1, 1);
    }
};

/**
* @param {any} sompi
* @param {Wallet} wallet
* @returns {string}
*/
module.exports.sompiToKaspaStringWithSuffix = function(sompi, wallet) {
    let deferred2_0;
    let deferred2_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        _assertClass(wallet, Wallet);
        wasm.sompiToKaspaStringWithSuffix(retptr, addHeapObject(sompi), wallet.__wbg_ptr);
        var r0 = getInt32Memory0()[retptr / 4 + 0];
        var r1 = getInt32Memory0()[retptr / 4 + 1];
        var r2 = getInt32Memory0()[retptr / 4 + 2];
        var r3 = getInt32Memory0()[retptr / 4 + 3];
        var ptr1 = r0;
        var len1 = r1;
        if (r3) {
            ptr1 = 0; len1 = 0;
            throw takeObject(r2);
        }
        deferred2_0 = ptr1;
        deferred2_1 = len1;
        return getStringFromWasm0(ptr1, len1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export_9(deferred2_0, deferred2_1, 1);
    }
};

/**
* @param {any} thresholds
*/
module.exports.configureUtxoProcessing = function(thresholds) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.configureUtxoProcessing(retptr, addBorrowedObject(thresholds));
        var r0 = getInt32Memory0()[retptr / 4 + 0];
        var r1 = getInt32Memory0()[retptr / 4 + 1];
        if (r1) {
            throw takeObject(r0);
        }
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        heap[stack_pointer++] = undefined;
    }
};

/**
* find Consensus parameters for given Address
* @param {Address} address
* @returns {ConsensusParams}
*/
module.exports.getConsensusParametersByAddress = function(address) {
    _assertClass(address, Address);
    const ret = wasm.getConsensusParametersByAddress(address.__wbg_ptr);
    return ConsensusParams.__wrap(ret);
};

/**
* find Consensus parameters for given NetworkType
* @param {number} network
* @returns {ConsensusParams}
*/
module.exports.getConsensusParametersByNetwork = function(network) {
    const ret = wasm.getConsensusParametersByNetwork(network);
    return ConsensusParams.__wrap(ret);
};

/**
* `calculate_difficulty` is based on set_difficulty function: https://github.com/tmrlvi/kaspa-miner/blob/bf361d02a46c580f55f46b5dfa773477634a5753/src/client/stratum.rs#L375
* @param {number} difficulty
* @returns {bigint}
*/
module.exports.calculateDifficulty = function(difficulty) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.calculateDifficulty(retptr, difficulty);
        var r0 = getInt32Memory0()[retptr / 4 + 0];
        var r1 = getInt32Memory0()[retptr / 4 + 1];
        var r2 = getInt32Memory0()[retptr / 4 + 2];
        if (r2) {
            throw takeObject(r1);
        }
        return takeObject(r0);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
};

let cachedUint32Memory0 = null;

function getUint32Memory0() {
    if (cachedUint32Memory0 === null || cachedUint32Memory0.byteLength === 0) {
        cachedUint32Memory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32Memory0;
}

function passArrayJsValueToWasm0(array, malloc) {
    const ptr = malloc(array.length * 4, 4) >>> 0;
    const mem = getUint32Memory0();
    for (let i = 0; i < array.length; i++) {
        mem[ptr / 4 + i] = addHeapObject(array[i]);
    }
    WASM_VECTOR_LEN = array.length;
    return ptr;
}

function getArrayJsValueFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    const mem = getUint32Memory0();
    const slice = mem.subarray(ptr / 4, ptr / 4 + len);
    const result = [];
    for (let i = 0; i < slice.length; i++) {
        result.push(takeObject(slice[i]));
    }
    return result;
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8Memory0().subarray(ptr / 1, ptr / 1 + len);
}
/**
* @returns {Promise<void>}
*/
module.exports.test = function() {
    const ret = wasm.test();
    return takeObject(ret);
};

/**
*r" Deferred promise - an object that has `resolve()` and `reject()`
*r" functions that can be called outside of the promise body.
* @returns {Promise<any>}
*/
module.exports.defer = function() {
    const ret = wasm.defer();
    return takeObject(ret);
};

/**
* Present panic logs to the user
*/
module.exports.presentPanicHookLogs = function() {
    wasm.presentPanicHookLogs();
};

/**
* Initialize panic hook in browser mode
*/
module.exports.initBrowserPanicHook = function() {
    wasm.initBrowserPanicHook();
};

/**
* Initialize panic hook in console mode
*/
module.exports.initConsolePanicHook = function() {
    wasm.initConsolePanicHook();
};

/**
*
*  Kaspa `Address` version (`PubKey`, `PubKey ECDSA`, `ScriptHash`)
*/
module.exports.AddressVersion = Object.freeze({
/**
* PubKey addresses always have the version byte set to 0
*/
PubKey:0,"0":"PubKey",
/**
* PubKey ECDSA addresses always have the version byte set to 1
*/
PubKeyECDSA:1,"1":"PubKeyECDSA",
/**
* ScriptHash addresses always have the version byte set to 8
*/
ScriptHash:8,"8":"ScriptHash", });
/**
* Supported languages.
*
* Presently only English is specified by the BIP39 standard
*/
module.exports.Language = Object.freeze({
/**
* English is presently the only supported language
*/
English:0,"0":"English", });
/**
*/
module.exports.NetworkType = Object.freeze({ Mainnet:0,"0":"Mainnet",Testnet:1,"1":"Testnet",Devnet:2,"2":"Devnet",Simnet:3,"3":"Simnet", });
/**
*/
module.exports.AccountKind = Object.freeze({ Legacy:0,"0":"Legacy",Bip32:1,"1":"Bip32",MultiSig:2,"2":"MultiSig",Keypair:3,"3":"Keypair",Hardware:4,"4":"Hardware",Resident:5,"5":"Resident", });
/**
* RPC protocol encoding: `Borsh` or `SerdeJson`
*/
module.exports.Encoding = Object.freeze({ Borsh:0,"0":"Borsh",SerdeJson:1,"1":"SerdeJson", });
/**
*
* Abortable trigger wraps an `Arc<AtomicBool>`, which can be cloned
* to signal task terminating using an atomic bool.
*
* ```
* let abortable = Abortable::default();
* let result = my_task(abortable).await?;
* // ... elsewhere
* abortable.abort();
* ```
*/
class Abortable {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(Abortable.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_abortable_free(ptr);
    }
    /**
    */
    constructor() {
        const ret = wasm.abortable_new();
        return Abortable.__wrap(ret);
    }
    /**
    * @returns {boolean}
    */
    isAborted() {
        const ret = wasm.abortable_isAborted(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
    */
    abort() {
        wasm.abortable_abort(this.__wbg_ptr);
    }
    /**
    */
    check() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.abortable_check(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            if (r1) {
                throw takeObject(r0);
            }
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
module.exports.Abortable = Abortable;
/**
*/
class Aborted {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(Aborted.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_aborted_free(ptr);
    }
}
module.exports.Aborted = Aborted;
/**
*/
class Account {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(Account.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    toJSON() {
        return {
            context: this.context,
            balance: this.balance,
            type: this.type,
            receiveAddress: this.receiveAddress,
            changeAddress: this.changeAddress,
        };
    }

    toString() {
        return JSON.stringify(this);
    }

    [inspect.custom]() {
        return Object.assign(Object.create({constructor: this.constructor}), this.toJSON());
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_account_free(ptr);
    }
    /**
    * @returns {UtxoContext}
    */
    get context() {
        const ret = wasm.__wbg_get_account_context(this.__wbg_ptr);
        return UtxoContext.__wrap(ret);
    }
    /**
    * @param {UtxoContext} arg0
    */
    set context(arg0) {
        _assertClass(arg0, UtxoContext);
        var ptr0 = arg0.__destroy_into_raw();
        wasm.__wbg_set_account_context(this.__wbg_ptr, ptr0);
    }
    /**
    * @param {any} js_value
    * @returns {Account}
    */
    static ctor(js_value) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.account_ctor(retptr, addHeapObject(js_value));
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return Account.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {any}
    */
    get balance() {
        const ret = wasm.account_balance(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {string}
    */
    get type() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.account_type(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * @param {any} network_type
    * @returns {any}
    */
    balanceStrings(network_type) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.account_balanceStrings(retptr, this.__wbg_ptr, addHeapObject(network_type));
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return takeObject(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {string}
    */
    get receiveAddress() {
        let deferred2_0;
        let deferred2_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.account_receiveAddress(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            var r3 = getInt32Memory0()[retptr / 4 + 3];
            var ptr1 = r0;
            var len1 = r1;
            if (r3) {
                ptr1 = 0; len1 = 0;
                throw takeObject(r2);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred2_0, deferred2_1, 1);
        }
    }
    /**
    * @returns {string}
    */
    get changeAddress() {
        let deferred2_0;
        let deferred2_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.account_changeAddress(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            var r3 = getInt32Memory0()[retptr / 4 + 3];
            var ptr1 = r0;
            var len1 = r1;
            if (r3) {
                ptr1 = 0; len1 = 0;
                throw takeObject(r2);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred2_0, deferred2_1, 1);
        }
    }
    /**
    * @returns {Promise<Address>}
    */
    deriveReceiveAddress() {
        const ret = wasm.account_deriveReceiveAddress(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {Promise<Address>}
    */
    deriveChangeAddress() {
        const ret = wasm.account_deriveChangeAddress(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {Promise<void>}
    */
    scan() {
        const ret = wasm.account_scan(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {any} js_value
    * @returns {Promise<any>}
    */
    send(js_value) {
        const ret = wasm.account_send(this.__wbg_ptr, addHeapObject(js_value));
        return takeObject(ret);
    }
}
module.exports.Account = Account;
/**
* Kaspa `Address` struct that serializes to and from an address format string: `kaspa:qz0s...t8cv`.
*/
class Address {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(Address.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    toJSON() {
        return {
            version: this.version,
            prefix: this.prefix,
            payload: this.payload,
        };
    }

    toString() {
        return JSON.stringify(this);
    }

    [inspect.custom]() {
        return Object.assign(Object.create({constructor: this.constructor}), this.toJSON());
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_address_free(ptr);
    }
    /**
    * @param {string} address
    */
    constructor(address) {
        const ptr0 = passStringToWasm0(address, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.address_constructor(ptr0, len0);
        return Address.__wrap(ret);
    }
    /**
    * Convert an address to a string.
    * @returns {string}
    */
    toString() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.address_toString(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * @returns {string}
    */
    get version() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.address_version(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * @returns {string}
    */
    get prefix() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.address_prefix(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * @param {string} prefix
    */
    set prefix(prefix) {
        const ptr0 = passStringToWasm0(prefix, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
        const len0 = WASM_VECTOR_LEN;
        wasm.address_set_prefix(this.__wbg_ptr, ptr0, len0);
    }
    /**
    * @returns {string}
    */
    get payload() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.address_payload(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * @param {number} n
    * @returns {string}
    */
    short(n) {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.address_short(retptr, this.__wbg_ptr, n);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred1_0, deferred1_1, 1);
        }
    }
}
module.exports.Address = Address;
/**
*/
class AddressList {

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_addresslist_free(ptr);
    }
}
module.exports.AddressList = AddressList;
/**
*/
class AgentConstructorOptions {

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_agentconstructoroptions_free(ptr);
    }
    /**
    * @returns {number}
    */
    get keep_alive_msecs() {
        const ret = wasm.agentconstructoroptions_keep_alive_msecs(this.__wbg_ptr);
        return ret;
    }
    /**
    * @param {number} value
    */
    set keep_alive_msecs(value) {
        wasm.agentconstructoroptions_set_keep_alive_msecs(this.__wbg_ptr, value);
    }
    /**
    * @returns {boolean}
    */
    get keep_alive() {
        const ret = wasm.agentconstructoroptions_keep_alive(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
    * @param {boolean} value
    */
    set keep_alive(value) {
        wasm.agentconstructoroptions_set_keep_alive(this.__wbg_ptr, value);
    }
    /**
    * @returns {number}
    */
    get max_free_sockets() {
        const ret = wasm.agentconstructoroptions_max_free_sockets(this.__wbg_ptr);
        return ret;
    }
    /**
    * @param {number} value
    */
    set max_free_sockets(value) {
        wasm.agentconstructoroptions_set_max_free_sockets(this.__wbg_ptr, value);
    }
    /**
    * @returns {number}
    */
    get max_sockets() {
        const ret = wasm.agentconstructoroptions_max_sockets(this.__wbg_ptr);
        return ret;
    }
    /**
    * @param {number} value
    */
    set max_sockets(value) {
        wasm.agentconstructoroptions_set_max_sockets(this.__wbg_ptr, value);
    }
    /**
    * @returns {number}
    */
    get timeout() {
        const ret = wasm.agentconstructoroptions_timeout(this.__wbg_ptr);
        return ret;
    }
    /**
    * @param {number} value
    */
    set timeout(value) {
        wasm.agentconstructoroptions_set_timeout(this.__wbg_ptr, value);
    }
}
module.exports.AgentConstructorOptions = AgentConstructorOptions;
/**
*/
class AppendFileOptions {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(AppendFileOptions.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_appendfileoptions_free(ptr);
    }
    /**
    * @param {string | undefined} encoding
    * @param {number | undefined} mode
    * @param {string | undefined} flag
    */
    constructor(encoding, mode, flag) {
        const ret = wasm.appendfileoptions_new_with_values(isLikeNone(encoding) ? 0 : addHeapObject(encoding), !isLikeNone(mode), isLikeNone(mode) ? 0 : mode, isLikeNone(flag) ? 0 : addHeapObject(flag));
        return AppendFileOptions.__wrap(ret);
    }
    /**
    * @returns {AppendFileOptions}
    */
    static new() {
        const ret = wasm.appendfileoptions_new();
        return AppendFileOptions.__wrap(ret);
    }
    /**
    * @returns {string | undefined}
    */
    get encoding() {
        const ret = wasm.appendfileoptions_encoding(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {string | undefined} value
    */
    set encoding(value) {
        wasm.appendfileoptions_set_encoding(this.__wbg_ptr, isLikeNone(value) ? 0 : addHeapObject(value));
    }
    /**
    * @returns {number | undefined}
    */
    get mode() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.appendfileoptions_mode(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            return r0 === 0 ? undefined : r1 >>> 0;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @param {number | undefined} value
    */
    set mode(value) {
        wasm.appendfileoptions_set_mode(this.__wbg_ptr, !isLikeNone(value), isLikeNone(value) ? 0 : value);
    }
    /**
    * @returns {string | undefined}
    */
    get flag() {
        const ret = wasm.appendfileoptions_flag(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {string | undefined} value
    */
    set flag(value) {
        wasm.appendfileoptions_set_flag(this.__wbg_ptr, isLikeNone(value) ? 0 : addHeapObject(value));
    }
}
module.exports.AppendFileOptions = AppendFileOptions;
/**
*/
class AssertionErrorOptions {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(AssertionErrorOptions.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_assertionerroroptions_free(ptr);
    }
    /**
    * @param {string | undefined} message
    * @param {any} actual
    * @param {any} expected
    * @param {string} operator
    */
    constructor(message, actual, expected, operator) {
        const ret = wasm.assertionerroroptions_new(isLikeNone(message) ? 0 : addHeapObject(message), addHeapObject(actual), addHeapObject(expected), addHeapObject(operator));
        return AssertionErrorOptions.__wrap(ret);
    }
    /**
    * If provided, the error message is set to this value.
    * @returns {string | undefined}
    */
    get message() {
        const ret = wasm.assertionerroroptions_message(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {string | undefined} value
    */
    set message(value) {
        wasm.assertionerroroptions_set_message(this.__wbg_ptr, isLikeNone(value) ? 0 : addHeapObject(value));
    }
    /**
    * The actual property on the error instance.
    * @returns {any}
    */
    get actual() {
        const ret = wasm.assertionerroroptions_actual(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {any} value
    */
    set actual(value) {
        wasm.assertionerroroptions_set_actual(this.__wbg_ptr, addHeapObject(value));
    }
    /**
    * The expected property on the error instance.
    * @returns {any}
    */
    get expected() {
        const ret = wasm.assertionerroroptions_expected(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {any} value
    */
    set expected(value) {
        wasm.assertionerroroptions_set_expected(this.__wbg_ptr, addHeapObject(value));
    }
    /**
    * The operator property on the error instance.
    * @returns {string}
    */
    get operator() {
        const ret = wasm.assertionerroroptions_operator(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {string} value
    */
    set operator(value) {
        wasm.assertionerroroptions_set_operator(this.__wbg_ptr, addHeapObject(value));
    }
}
module.exports.AssertionErrorOptions = AssertionErrorOptions;
/**
*/
class AsyncStreamProxy {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(AsyncStreamProxy.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_asyncstreamproxy_free(ptr);
    }
    /**
    * @returns {Promise<any>}
    */
    next() {
        const ret = wasm.asyncstreamproxy_next(this.__wbg_ptr);
        return takeObject(ret);
    }
}
module.exports.AsyncStreamProxy = AsyncStreamProxy;
/**
*/
class Balance {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(Balance.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_balance_free(ptr);
    }
    /**
    * @returns {bigint}
    */
    get mature() {
        const ret = wasm.balance_mature(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {bigint}
    */
    get pending() {
        const ret = wasm.balance_pending(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {any} network_type
    * @returns {BalanceStrings}
    */
    as_strings(network_type) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.balance_as_strings(retptr, this.__wbg_ptr, addHeapObject(network_type));
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return BalanceStrings.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
module.exports.Balance = Balance;
/**
*/
class BalanceStrings {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(BalanceStrings.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_balancestrings_free(ptr);
    }
    /**
    * @returns {any}
    */
    get mature() {
        const ret = wasm.balancestrings_mature(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {any}
    */
    get pending() {
        const ret = wasm.balancestrings_pending(this.__wbg_ptr);
        return takeObject(ret);
    }
}
module.exports.BalanceStrings = BalanceStrings;
/**
*/
class ConsensusParams {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(ConsensusParams.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_consensusparams_free(ptr);
    }
}
module.exports.ConsensusParams = ConsensusParams;
/**
*/
class ConsoleConstructorOptions {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(ConsoleConstructorOptions.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_consoleconstructoroptions_free(ptr);
    }
    /**
    * @param {any} stdout
    * @param {any} stderr
    * @param {boolean | undefined} ignore_errors
    * @param {any} color_mod
    * @param {object | undefined} inspect_options
    */
    constructor(stdout, stderr, ignore_errors, color_mod, inspect_options) {
        const ret = wasm.consoleconstructoroptions_new_with_values(addHeapObject(stdout), addHeapObject(stderr), isLikeNone(ignore_errors) ? 0xFFFFFF : ignore_errors ? 1 : 0, addHeapObject(color_mod), isLikeNone(inspect_options) ? 0 : addHeapObject(inspect_options));
        return ConsoleConstructorOptions.__wrap(ret);
    }
    /**
    * @param {any} stdout
    * @param {any} stderr
    * @returns {ConsoleConstructorOptions}
    */
    static new(stdout, stderr) {
        const ret = wasm.consoleconstructoroptions_new(addHeapObject(stdout), addHeapObject(stderr));
        return ConsoleConstructorOptions.__wrap(ret);
    }
    /**
    * @returns {any}
    */
    get stdout() {
        const ret = wasm.consoleconstructoroptions_stdout(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {any} value
    */
    set stdout(value) {
        wasm.consoleconstructoroptions_set_stdout(this.__wbg_ptr, addHeapObject(value));
    }
    /**
    * @returns {any}
    */
    get stderr() {
        const ret = wasm.consoleconstructoroptions_stderr(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {any} value
    */
    set stderr(value) {
        wasm.consoleconstructoroptions_set_stderr(this.__wbg_ptr, addHeapObject(value));
    }
    /**
    * @returns {boolean | undefined}
    */
    get ignore_errors() {
        const ret = wasm.consoleconstructoroptions_ignore_errors(this.__wbg_ptr);
        return ret === 0xFFFFFF ? undefined : ret !== 0;
    }
    /**
    * @param {boolean | undefined} value
    */
    set ignore_errors(value) {
        wasm.consoleconstructoroptions_set_ignore_errors(this.__wbg_ptr, isLikeNone(value) ? 0xFFFFFF : value ? 1 : 0);
    }
    /**
    * @returns {any}
    */
    get color_mod() {
        const ret = wasm.consoleconstructoroptions_color_mod(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {any} value
    */
    set color_mod(value) {
        wasm.consoleconstructoroptions_set_color_mod(this.__wbg_ptr, addHeapObject(value));
    }
    /**
    * @returns {object | undefined}
    */
    get inspect_options() {
        const ret = wasm.consoleconstructoroptions_inspect_options(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {object | undefined} value
    */
    set inspect_options(value) {
        wasm.consoleconstructoroptions_set_inspect_options(this.__wbg_ptr, isLikeNone(value) ? 0 : addHeapObject(value));
    }
}
module.exports.ConsoleConstructorOptions = ConsoleConstructorOptions;
/**
*/
class CreateHookCallbacks {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(CreateHookCallbacks.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_createhookcallbacks_free(ptr);
    }
    /**
    * @param {Function} init
    * @param {Function} before
    * @param {Function} after
    * @param {Function} destroy
    * @param {Function} promise_resolve
    */
    constructor(init, before, after, destroy, promise_resolve) {
        try {
            const ret = wasm.createhookcallbacks_new(addBorrowedObject(init), addBorrowedObject(before), addBorrowedObject(after), addBorrowedObject(destroy), addBorrowedObject(promise_resolve));
            return CreateHookCallbacks.__wrap(ret);
        } finally {
            heap[stack_pointer++] = undefined;
            heap[stack_pointer++] = undefined;
            heap[stack_pointer++] = undefined;
            heap[stack_pointer++] = undefined;
            heap[stack_pointer++] = undefined;
        }
    }
    /**
    * @returns {Function}
    */
    get init() {
        const ret = wasm.createhookcallbacks_init(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {Function} value
    */
    set init(value) {
        wasm.createhookcallbacks_set_init(this.__wbg_ptr, addHeapObject(value));
    }
    /**
    * @returns {Function}
    */
    get before() {
        const ret = wasm.createhookcallbacks_before(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {Function} value
    */
    set before(value) {
        wasm.createhookcallbacks_set_before(this.__wbg_ptr, addHeapObject(value));
    }
    /**
    * @returns {Function}
    */
    get after() {
        const ret = wasm.createhookcallbacks_after(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {Function} value
    */
    set after(value) {
        wasm.createhookcallbacks_set_after(this.__wbg_ptr, addHeapObject(value));
    }
    /**
    * @returns {Function}
    */
    get destroy() {
        const ret = wasm.createhookcallbacks_destroy(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {Function} value
    */
    set destroy(value) {
        wasm.createhookcallbacks_set_destroy(this.__wbg_ptr, addHeapObject(value));
    }
    /**
    * @returns {Function}
    */
    get promise_resolve() {
        const ret = wasm.createhookcallbacks_promise_resolve(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {Function} value
    */
    set promise_resolve(value) {
        wasm.createhookcallbacks_set_promise_resolve(this.__wbg_ptr, addHeapObject(value));
    }
}
module.exports.CreateHookCallbacks = CreateHookCallbacks;
/**
*/
class CreateReadStreamOptions {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(CreateReadStreamOptions.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_createreadstreamoptions_free(ptr);
    }
    /**
    * @param {boolean | undefined} auto_close
    * @param {boolean | undefined} emit_close
    * @param {string | undefined} encoding
    * @param {number | undefined} end
    * @param {number | undefined} fd
    * @param {string | undefined} flags
    * @param {number | undefined} high_water_mark
    * @param {number | undefined} mode
    * @param {number | undefined} start
    */
    constructor(auto_close, emit_close, encoding, end, fd, flags, high_water_mark, mode, start) {
        const ret = wasm.createreadstreamoptions_new_with_values(isLikeNone(auto_close) ? 0xFFFFFF : auto_close ? 1 : 0, isLikeNone(emit_close) ? 0xFFFFFF : emit_close ? 1 : 0, isLikeNone(encoding) ? 0 : addHeapObject(encoding), !isLikeNone(end), isLikeNone(end) ? 0 : end, !isLikeNone(fd), isLikeNone(fd) ? 0 : fd, isLikeNone(flags) ? 0 : addHeapObject(flags), !isLikeNone(high_water_mark), isLikeNone(high_water_mark) ? 0 : high_water_mark, !isLikeNone(mode), isLikeNone(mode) ? 0 : mode, !isLikeNone(start), isLikeNone(start) ? 0 : start);
        return CreateReadStreamOptions.__wrap(ret);
    }
    /**
    * @returns {boolean | undefined}
    */
    get auto_close() {
        const ret = wasm.createreadstreamoptions_auto_close(this.__wbg_ptr);
        return ret === 0xFFFFFF ? undefined : ret !== 0;
    }
    /**
    * @param {boolean | undefined} value
    */
    set auto_close(value) {
        wasm.createreadstreamoptions_set_auto_close(this.__wbg_ptr, isLikeNone(value) ? 0xFFFFFF : value ? 1 : 0);
    }
    /**
    * @returns {boolean | undefined}
    */
    get emit_close() {
        const ret = wasm.createreadstreamoptions_emit_close(this.__wbg_ptr);
        return ret === 0xFFFFFF ? undefined : ret !== 0;
    }
    /**
    * @param {boolean | undefined} value
    */
    set emit_close(value) {
        wasm.createreadstreamoptions_set_emit_close(this.__wbg_ptr, isLikeNone(value) ? 0xFFFFFF : value ? 1 : 0);
    }
    /**
    * @returns {string | undefined}
    */
    get encoding() {
        const ret = wasm.createreadstreamoptions_encoding(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {string | undefined} value
    */
    set encoding(value) {
        wasm.createreadstreamoptions_set_encoding(this.__wbg_ptr, isLikeNone(value) ? 0 : addHeapObject(value));
    }
    /**
    * @returns {number | undefined}
    */
    get end() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.createreadstreamoptions_end(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r2 = getFloat64Memory0()[retptr / 8 + 1];
            return r0 === 0 ? undefined : r2;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @param {number | undefined} value
    */
    set end(value) {
        wasm.createreadstreamoptions_set_end(this.__wbg_ptr, !isLikeNone(value), isLikeNone(value) ? 0 : value);
    }
    /**
    * @returns {number | undefined}
    */
    get fd() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.createreadstreamoptions_fd(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            return r0 === 0 ? undefined : r1 >>> 0;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @param {number | undefined} value
    */
    set fd(value) {
        wasm.createreadstreamoptions_set_fd(this.__wbg_ptr, !isLikeNone(value), isLikeNone(value) ? 0 : value);
    }
    /**
    * @returns {string | undefined}
    */
    get flags() {
        const ret = wasm.createreadstreamoptions_flags(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {string | undefined} value
    */
    set flags(value) {
        wasm.createreadstreamoptions_set_flags(this.__wbg_ptr, isLikeNone(value) ? 0 : addHeapObject(value));
    }
    /**
    * @returns {number | undefined}
    */
    get high_water_mark() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.createreadstreamoptions_high_water_mark(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r2 = getFloat64Memory0()[retptr / 8 + 1];
            return r0 === 0 ? undefined : r2;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @param {number | undefined} value
    */
    set high_water_mark(value) {
        wasm.createreadstreamoptions_set_high_water_mark(this.__wbg_ptr, !isLikeNone(value), isLikeNone(value) ? 0 : value);
    }
    /**
    * @returns {number | undefined}
    */
    get mode() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.createreadstreamoptions_mode(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            return r0 === 0 ? undefined : r1 >>> 0;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @param {number | undefined} value
    */
    set mode(value) {
        wasm.createreadstreamoptions_set_mode(this.__wbg_ptr, !isLikeNone(value), isLikeNone(value) ? 0 : value);
    }
    /**
    * @returns {number | undefined}
    */
    get start() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.createreadstreamoptions_start(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r2 = getFloat64Memory0()[retptr / 8 + 1];
            return r0 === 0 ? undefined : r2;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @param {number | undefined} value
    */
    set start(value) {
        wasm.createreadstreamoptions_set_start(this.__wbg_ptr, !isLikeNone(value), isLikeNone(value) ? 0 : value);
    }
}
module.exports.CreateReadStreamOptions = CreateReadStreamOptions;
/**
*/
class CreateWriteStreamOptions {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(CreateWriteStreamOptions.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_createwritestreamoptions_free(ptr);
    }
    /**
    * @param {boolean | undefined} auto_close
    * @param {boolean | undefined} emit_close
    * @param {string | undefined} encoding
    * @param {number | undefined} fd
    * @param {string | undefined} flags
    * @param {number | undefined} mode
    * @param {number | undefined} start
    */
    constructor(auto_close, emit_close, encoding, fd, flags, mode, start) {
        const ret = wasm.createwritestreamoptions_new_with_values(isLikeNone(auto_close) ? 0xFFFFFF : auto_close ? 1 : 0, isLikeNone(emit_close) ? 0xFFFFFF : emit_close ? 1 : 0, isLikeNone(encoding) ? 0 : addHeapObject(encoding), !isLikeNone(fd), isLikeNone(fd) ? 0 : fd, isLikeNone(flags) ? 0 : addHeapObject(flags), !isLikeNone(mode), isLikeNone(mode) ? 0 : mode, !isLikeNone(start), isLikeNone(start) ? 0 : start);
        return CreateWriteStreamOptions.__wrap(ret);
    }
    /**
    * @returns {boolean | undefined}
    */
    get auto_close() {
        const ret = wasm.createwritestreamoptions_auto_close(this.__wbg_ptr);
        return ret === 0xFFFFFF ? undefined : ret !== 0;
    }
    /**
    * @param {boolean | undefined} value
    */
    set auto_close(value) {
        wasm.createwritestreamoptions_set_auto_close(this.__wbg_ptr, isLikeNone(value) ? 0xFFFFFF : value ? 1 : 0);
    }
    /**
    * @returns {boolean | undefined}
    */
    get emit_close() {
        const ret = wasm.createwritestreamoptions_emit_close(this.__wbg_ptr);
        return ret === 0xFFFFFF ? undefined : ret !== 0;
    }
    /**
    * @param {boolean | undefined} value
    */
    set emit_close(value) {
        wasm.createwritestreamoptions_set_emit_close(this.__wbg_ptr, isLikeNone(value) ? 0xFFFFFF : value ? 1 : 0);
    }
    /**
    * @returns {string | undefined}
    */
    get encoding() {
        const ret = wasm.createwritestreamoptions_encoding(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {string | undefined} value
    */
    set encoding(value) {
        wasm.createwritestreamoptions_set_encoding(this.__wbg_ptr, isLikeNone(value) ? 0 : addHeapObject(value));
    }
    /**
    * @returns {number | undefined}
    */
    get fd() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.createwritestreamoptions_fd(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            return r0 === 0 ? undefined : r1 >>> 0;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @param {number | undefined} value
    */
    set fd(value) {
        wasm.createwritestreamoptions_set_fd(this.__wbg_ptr, !isLikeNone(value), isLikeNone(value) ? 0 : value);
    }
    /**
    * @returns {string | undefined}
    */
    get flags() {
        const ret = wasm.createwritestreamoptions_flags(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {string | undefined} value
    */
    set flags(value) {
        wasm.createwritestreamoptions_set_flags(this.__wbg_ptr, isLikeNone(value) ? 0 : addHeapObject(value));
    }
    /**
    * @returns {number | undefined}
    */
    get mode() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.createwritestreamoptions_mode(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            return r0 === 0 ? undefined : r1 >>> 0;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @param {number | undefined} value
    */
    set mode(value) {
        wasm.createwritestreamoptions_set_mode(this.__wbg_ptr, !isLikeNone(value), isLikeNone(value) ? 0 : value);
    }
    /**
    * @returns {number | undefined}
    */
    get start() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.createwritestreamoptions_start(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r2 = getFloat64Memory0()[retptr / 8 + 1];
            return r0 === 0 ? undefined : r2;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @param {number | undefined} value
    */
    set start(value) {
        wasm.createwritestreamoptions_set_start(this.__wbg_ptr, !isLikeNone(value), isLikeNone(value) ? 0 : value);
    }
}
module.exports.CreateWriteStreamOptions = CreateWriteStreamOptions;
/**
*/
class DerivationPath {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(DerivationPath.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_derivationpath_free(ptr);
    }
    /**
    * @param {string} path
    */
    constructor(path) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(path, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
            const len0 = WASM_VECTOR_LEN;
            wasm.derivationpath_new(retptr, ptr0, len0);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return DerivationPath.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * Is this derivation path empty? (i.e. the root)
    * @returns {boolean}
    */
    isEmpty() {
        const ret = wasm.derivationpath_isEmpty(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
    * Get the count of [`ChildNumber`] values in this derivation path.
    * @returns {number}
    */
    length() {
        const ret = wasm.derivationpath_length(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
    * Get the parent [`DerivationPath`] for the current one.
    *
    * Returns `Undefined` if this is already the root path.
    * @returns {DerivationPath | undefined}
    */
    parent() {
        const ret = wasm.derivationpath_parent(this.__wbg_ptr);
        return ret === 0 ? undefined : DerivationPath.__wrap(ret);
    }
    /**
    * Push a [`ChildNumber`] onto an existing derivation path.
    * @param {number} child_number
    * @param {boolean | undefined} hardened
    */
    push(child_number, hardened) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.derivationpath_push(retptr, this.__wbg_ptr, child_number, isLikeNone(hardened) ? 0xFFFFFF : hardened ? 1 : 0);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            if (r1) {
                throw takeObject(r0);
            }
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {string}
    */
    toString() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.derivationpath_toString(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred1_0, deferred1_1, 1);
        }
    }
}
module.exports.DerivationPath = DerivationPath;
/**
*
* [`EventDispatcher`] is an object meant to be used in WASM environment to
* process channel events.
*/
class EventDispatcher {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(EventDispatcher.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    toJSON() {
        return {
            listener: this.listener,
        };
    }

    toString() {
        return JSON.stringify(this);
    }

    [inspect.custom]() {
        return Object.assign(Object.create({constructor: this.constructor}), this.toJSON());
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_eventdispatcher_free(ptr);
    }
    /**
    */
    constructor() {
        const ret = wasm.eventdispatcher_new();
        return EventDispatcher.__wrap(ret);
    }
    /**
    * @returns {any}
    */
    get listener() {
        const ret = wasm.eventdispatcher_listener(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {any} callback
    */
    set listener(callback) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.eventdispatcher_set_listener(retptr, this.__wbg_ptr, addHeapObject(callback));
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            if (r1) {
                throw takeObject(r0);
            }
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @param {any} callback
    */
    registerListener(callback) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.eventdispatcher_registerListener(retptr, this.__wbg_ptr, addHeapObject(callback));
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            if (r1) {
                throw takeObject(r0);
            }
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * `removeListenet` must be called when releasing ReflectorClient
    * to stop the background event processing task
    */
    removeListener() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.eventdispatcher_removeListener(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            if (r1) {
                throw takeObject(r0);
            }
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {Promise<void>}
    */
    stop() {
        const ret = wasm.eventdispatcher_stop(this.__wbg_ptr);
        return takeObject(ret);
    }
}
module.exports.EventDispatcher = EventDispatcher;
/**
*/
class FormatInputPathObject {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(FormatInputPathObject.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_formatinputpathobject_free(ptr);
    }
    /**
    * @param {string | undefined} base
    * @param {string | undefined} dir
    * @param {string | undefined} ext
    * @param {string | undefined} name
    * @param {string | undefined} root
    */
    constructor(base, dir, ext, name, root) {
        const ret = wasm.formatinputpathobject_new_with_values(isLikeNone(base) ? 0 : addHeapObject(base), isLikeNone(dir) ? 0 : addHeapObject(dir), isLikeNone(ext) ? 0 : addHeapObject(ext), isLikeNone(name) ? 0 : addHeapObject(name), isLikeNone(root) ? 0 : addHeapObject(root));
        return FormatInputPathObject.__wrap(ret);
    }
    /**
    * @returns {FormatInputPathObject}
    */
    static new() {
        const ret = wasm.formatinputpathobject_new();
        return FormatInputPathObject.__wrap(ret);
    }
    /**
    * @returns {string | undefined}
    */
    get base() {
        const ret = wasm.formatinputpathobject_base(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {string | undefined} value
    */
    set base(value) {
        wasm.formatinputpathobject_set_base(this.__wbg_ptr, isLikeNone(value) ? 0 : addHeapObject(value));
    }
    /**
    * @returns {string | undefined}
    */
    get dir() {
        const ret = wasm.formatinputpathobject_dir(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {string | undefined} value
    */
    set dir(value) {
        wasm.formatinputpathobject_set_dir(this.__wbg_ptr, isLikeNone(value) ? 0 : addHeapObject(value));
    }
    /**
    * @returns {string | undefined}
    */
    get ext() {
        const ret = wasm.formatinputpathobject_ext(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {string | undefined} value
    */
    set ext(value) {
        wasm.formatinputpathobject_set_ext(this.__wbg_ptr, isLikeNone(value) ? 0 : addHeapObject(value));
    }
    /**
    * @returns {string | undefined}
    */
    get name() {
        const ret = wasm.formatinputpathobject_name(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {string | undefined} value
    */
    set name(value) {
        wasm.formatinputpathobject_set_name(this.__wbg_ptr, isLikeNone(value) ? 0 : addHeapObject(value));
    }
    /**
    * @returns {string | undefined}
    */
    get root() {
        const ret = wasm.formatinputpathobject_root(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {string | undefined} value
    */
    set root(value) {
        wasm.formatinputpathobject_set_root(this.__wbg_ptr, isLikeNone(value) ? 0 : addHeapObject(value));
    }
}
module.exports.FormatInputPathObject = FormatInputPathObject;
/**
* [`Generator`] is a type capable of generating transactions based on a supplied
* set of UTXO entries or a UTXO entry producer (such as `UtxoContext`). The [`Generator`]
* accumulates UTXO entries until it can generate a transaction that meets the
* requested amount or until the total mass of created inputs exceeds the allowed
* transaction mass, at which point it will produce a compound transaction by forwarding
* all selected UTXO entries to the supplied change address and prepare to start generating
* a new transaction.  Such sequence of daisy-chained transactions is known as a "batch".
* Each compount transaction results in a new UTXO, which is immediately reused in the
* subsequent transaction.
*
* ```javascript
*
* let generator = new Generator({
*     utxoEntries : [...],
*     changeAddress : "kaspa:...",
*     outputs : [[1000, "kaspa:..."], [2000, "kaspa:..."], ...],
*     priorityFee : 1000n,
* });
*
* while(transaction = await generator.next()) {
*     await transaction.sign(privateKeys);
*     await transaction.submit(rpc);
* }
*
* let summary = generator.summary();
* console.log(summary);
*
* ```
*/
class Generator {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(Generator.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_generator_free(ptr);
    }
    /**
    * @param {PrivateKey[]} args
    */
    constructor(args) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.generator_ctor(retptr, addHeapObject(args));
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return Generator.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * Generate next transaction
    * @returns {Promise<any>}
    */
    next() {
        const ret = wasm.generator_next(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {Promise<GeneratorSummary>}
    */
    estimate() {
        const ret = wasm.generator_estimate(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {GeneratorSummary}
    */
    summary() {
        const ret = wasm.generator_summary(this.__wbg_ptr);
        return GeneratorSummary.__wrap(ret);
    }
}
module.exports.Generator = Generator;
/**
*/
class GeneratorSummary {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(GeneratorSummary.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    toJSON() {
        return {
            networkType: this.networkType,
            utxos: this.utxos,
            fees: this.fees,
            transactions: this.transactions,
            finalAmount: this.finalAmount,
            finalTransactionId: this.finalTransactionId,
        };
    }

    toString() {
        return JSON.stringify(this);
    }

    [inspect.custom]() {
        return Object.assign(Object.create({constructor: this.constructor}), this.toJSON());
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_generatorsummary_free(ptr);
    }
    /**
    * @returns {number}
    */
    get networkType() {
        const ret = wasm.generatorsummary_networkType(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
    * @returns {number}
    */
    get utxos() {
        const ret = wasm.generatorsummary_utxos(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
    * @returns {bigint}
    */
    get fees() {
        const ret = wasm.generatorsummary_fees(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {number}
    */
    get transactions() {
        const ret = wasm.generatorsummary_transactions(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
    * @returns {bigint | undefined}
    */
    get finalAmount() {
        const ret = wasm.generatorsummary_finalAmount(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {string | undefined}
    */
    get finalTransactionId() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.generatorsummary_finalTransactionId(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            let v1;
            if (r0 !== 0) {
                v1 = getStringFromWasm0(r0, r1).slice();
                wasm.__wbindgen_export_9(r0, r1 * 1);
            }
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
module.exports.GeneratorSummary = GeneratorSummary;
/**
*/
class GetNameOptions {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(GetNameOptions.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_getnameoptions_free(ptr);
    }
    /**
    * @param {number | undefined} family
    * @param {string} host
    * @param {string} local_address
    * @param {number} port
    * @returns {GetNameOptions}
    */
    static new(family, host, local_address, port) {
        const ret = wasm.getnameoptions_new(isLikeNone(family) ? 0xFFFFFF : family, addHeapObject(host), addHeapObject(local_address), port);
        return GetNameOptions.__wrap(ret);
    }
    /**
    * @returns {number | undefined}
    */
    get family() {
        const ret = wasm.getnameoptions_family(this.__wbg_ptr);
        return ret === 0xFFFFFF ? undefined : ret;
    }
    /**
    * @param {number | undefined} value
    */
    set family(value) {
        wasm.getnameoptions_set_family(this.__wbg_ptr, isLikeNone(value) ? 0xFFFFFF : value);
    }
    /**
    * @returns {string}
    */
    get host() {
        const ret = wasm.getnameoptions_host(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {string} value
    */
    set host(value) {
        wasm.getnameoptions_set_host(this.__wbg_ptr, addHeapObject(value));
    }
    /**
    * @returns {string}
    */
    get local_address() {
        const ret = wasm.getnameoptions_local_address(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {string} value
    */
    set local_address(value) {
        wasm.getnameoptions_set_local_address(this.__wbg_ptr, addHeapObject(value));
    }
    /**
    * @returns {number}
    */
    get port() {
        const ret = wasm.getnameoptions_port(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
    * @param {number} value
    */
    set port(value) {
        wasm.getnameoptions_set_port(this.__wbg_ptr, value);
    }
}
module.exports.GetNameOptions = GetNameOptions;
/**
*/
class Hash {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(Hash.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_hash_free(ptr);
    }
    /**
    * @param {string} hex_str
    */
    constructor(hex_str) {
        const ptr0 = passStringToWasm0(hex_str, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.hash_constructor(ptr0, len0);
        return Hash.__wrap(ret);
    }
    /**
    * @returns {string}
    */
    toString() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.hash_toString(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred1_0, deferred1_1, 1);
        }
    }
}
module.exports.Hash = Hash;
/**
*/
class Header {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(Header.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    toJSON() {
        return {
            version: this.version,
            timestamp: this.timestamp,
            bits: this.bits,
            nonce: this.nonce,
            daaScore: this.daaScore,
            blueScore: this.blueScore,
            hash: this.hash,
            hashMerkleRoot: this.hashMerkleRoot,
            acceptedIdMerkleRoot: this.acceptedIdMerkleRoot,
            utxoCommitment: this.utxoCommitment,
            pruningPoint: this.pruningPoint,
            parentsByLevel: this.parentsByLevel,
            blueWork: this.blueWork,
        };
    }

    toString() {
        return JSON.stringify(this);
    }

    [inspect.custom]() {
        return Object.assign(Object.create({constructor: this.constructor}), this.toJSON());
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_header_free(ptr);
    }
    /**
    * @returns {number}
    */
    get version() {
        const ret = wasm.__wbg_get_header_version(this.__wbg_ptr);
        return ret;
    }
    /**
    * @param {number} arg0
    */
    set version(arg0) {
        wasm.__wbg_set_header_version(this.__wbg_ptr, arg0);
    }
    /**
    * @returns {bigint}
    */
    get timestamp() {
        const ret = wasm.__wbg_get_header_timestamp(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
    * @param {bigint} arg0
    */
    set timestamp(arg0) {
        wasm.__wbg_set_header_timestamp(this.__wbg_ptr, arg0);
    }
    /**
    * @returns {number}
    */
    get bits() {
        const ret = wasm.__wbg_get_header_bits(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
    * @param {number} arg0
    */
    set bits(arg0) {
        wasm.__wbg_set_header_bits(this.__wbg_ptr, arg0);
    }
    /**
    * @returns {bigint}
    */
    get nonce() {
        const ret = wasm.__wbg_get_header_nonce(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
    * @param {bigint} arg0
    */
    set nonce(arg0) {
        wasm.__wbg_set_header_nonce(this.__wbg_ptr, arg0);
    }
    /**
    * @returns {bigint}
    */
    get daaScore() {
        const ret = wasm.__wbg_get_header_daaScore(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
    * @param {bigint} arg0
    */
    set daaScore(arg0) {
        wasm.__wbg_set_header_daaScore(this.__wbg_ptr, arg0);
    }
    /**
    * @returns {bigint}
    */
    get blueScore() {
        const ret = wasm.__wbg_get_header_blueScore(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
    * @param {bigint} arg0
    */
    set blueScore(arg0) {
        wasm.__wbg_set_header_blueScore(this.__wbg_ptr, arg0);
    }
    /**
    * Finalizes the header and recomputes (updates) the header hash
    * @return { String } header hash
    * @returns {string}
    */
    finalize() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.header_finalize(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * @param {any} js_value
    */
    constructor(js_value) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.header_constructor(retptr, addHeapObject(js_value));
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return Header.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * Obtain `JSON` representation of the header. JSON representation
    * should be obtained using WASM, to ensure proper serialization of
    * big integers.
    * @returns {string}
    */
    asJSON() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.header_asJSON(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * @returns {string}
    */
    get hash() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.header_get_hash_as_hex(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * @returns {string}
    */
    get hashMerkleRoot() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.header_get_hash_merkle_root_as_hex(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * @param {any} js_value
    */
    set hashMerkleRoot(js_value) {
        wasm.header_set_hash_merkle_root_from_js_value(this.__wbg_ptr, addHeapObject(js_value));
    }
    /**
    * @returns {string}
    */
    get acceptedIdMerkleRoot() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.header_get_accepted_id_merkle_root_as_hex(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * @param {any} js_value
    */
    set acceptedIdMerkleRoot(js_value) {
        wasm.header_set_accepted_id_merkle_root_from_js_value(this.__wbg_ptr, addHeapObject(js_value));
    }
    /**
    * @returns {string}
    */
    get utxoCommitment() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.header_get_utxo_commitment_as_hex(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * @param {any} js_value
    */
    set utxoCommitment(js_value) {
        wasm.header_set_utxo_commitment_from_js_value(this.__wbg_ptr, addHeapObject(js_value));
    }
    /**
    * @returns {string}
    */
    get pruningPoint() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.header_get_pruning_point_as_hex(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * @param {any} js_value
    */
    set pruningPoint(js_value) {
        wasm.header_set_pruning_point_from_js_value(this.__wbg_ptr, addHeapObject(js_value));
    }
    /**
    * @returns {any}
    */
    get parentsByLevel() {
        const ret = wasm.header_get_parents_by_level_as_js_value(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {any} js_value
    */
    set parentsByLevel(js_value) {
        wasm.header_set_parents_by_level_from_js_value(this.__wbg_ptr, addHeapObject(js_value));
    }
    /**
    * @returns {bigint}
    */
    get blueWork() {
        const ret = wasm.header_blue_work(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {string}
    */
    getBlueWorkAsHex() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.header_getBlueWorkAsHex(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * @param {any} js_value
    */
    set blueWork(js_value) {
        wasm.header_set_blue_work_from_js_value(this.__wbg_ptr, addHeapObject(js_value));
    }
}
module.exports.Header = Header;
/**
* Data structure that contains a secret and public keys.
*/
class Keypair {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(Keypair.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    toJSON() {
        return {
            publicKey: this.publicKey,
            privateKey: this.privateKey,
            xOnlyPublicKey: this.xOnlyPublicKey,
        };
    }

    toString() {
        return JSON.stringify(this);
    }

    [inspect.custom]() {
        return Object.assign(Object.create({constructor: this.constructor}), this.toJSON());
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_keypair_free(ptr);
    }
    /**
    * Get the [`PublicKey`] of this [`Keypair`].
    * @returns {any}
    */
    get publicKey() {
        const ret = wasm.keypair_get_public_key(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * Get the [`PrivateKey`] of this [`Keypair`].
    * @returns {PrivateKey}
    */
    get privateKey() {
        const ret = wasm.keypair_get_private_key(this.__wbg_ptr);
        return PrivateKey.__wrap(ret);
    }
    /**
    * Get the `XOnlyPublicKey` of this [`Keypair`].
    * @returns {any}
    */
    get xOnlyPublicKey() {
        const ret = wasm.keypair_get_xonly_public_key(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * Get the [`Address`] of this Keypair's [`PublicKey`].
    * Receives a [`NetworkType`] to determine the prefix of the address.
    * JavaScript: `let address = keypair.toAddress(NetworkType.MAINNET);`.
    * @param {NetworkType | NetworkId | string} network
    * @returns {Address}
    */
    toAddress(network) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.keypair_toAddress(retptr, this.__wbg_ptr, addHeapObject(network));
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return Address.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * Get `ECDSA` [`Address`] of this Keypair's [`PublicKey`].
    * Receives a [`NetworkType`] to determine the prefix of the address.
    * JavaScript: `let address = keypair.toAddress(NetworkType.MAINNET);`.
    * @param {NetworkType | NetworkId | string} network
    * @returns {Address}
    */
    toAddressECDSA(network) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.keypair_toAddressECDSA(retptr, this.__wbg_ptr, addHeapObject(network));
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return Address.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * Create a new random [`Keypair`].
    * JavaScript: `let keypair = Keypair::random();`.
    * @returns {Keypair}
    */
    static random() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.keypair_random(retptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return Keypair.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * Create a new [`Keypair`] from a [`PrivateKey`].
    * JavaScript: `let privkey = new PrivateKey(hexString); let keypair = privkey.toKeypair();`.
    * @param {PrivateKey} secret_key
    * @returns {Keypair}
    */
    static fromPrivateKey(secret_key) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            _assertClass(secret_key, PrivateKey);
            wasm.keypair_fromPrivateKey(retptr, secret_key.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return Keypair.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
module.exports.Keypair = Keypair;
/**
*/
class MassCalculator {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(MassCalculator.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_masscalculator_free(ptr);
    }
    /**
    * @param {ConsensusParams} cp
    */
    constructor(cp) {
        _assertClass(cp, ConsensusParams);
        var ptr0 = cp.__destroy_into_raw();
        const ret = wasm.masscalculator_new(ptr0);
        return MassCalculator.__wrap(ret);
    }
    /**
    * @param {bigint} amount
    * @returns {boolean}
    */
    static isStandardOutputAmountDust(amount) {
        const ret = wasm.masscalculator_isStandardOutputAmountDust(amount);
        return ret !== 0;
    }
    /**
    * `isTransactionOutputDust()` returns whether or not the passed transaction output
    * amount is considered dust or not based on the configured minimum transaction
    * relay fee.
    *
    * Dust is defined in terms of the minimum transaction relay fee. In particular,
    * if the cost to the network to spend coins is more than 1/3 of the minimum
    * transaction relay fee, it is considered dust.
    *
    * It is exposed by [MiningManager] for use by transaction generators and wallets.
    * @param {any} transaction_output
    * @returns {boolean}
    */
    static isTransactionOutputDust(transaction_output) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.masscalculator_isTransactionOutputDust(retptr, addHeapObject(transaction_output));
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return r0 !== 0;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * `minimumRelayTransactionFee()` specifies the minimum transaction fee for a transaction to be accepted to
    * the mempool and relayed. It is specified in sompi per 1kg (or 1000 grams) of transaction mass.
    *
    * `pub(crate) const MINIMUM_RELAY_TRANSACTION_FEE: u64 = 1000;`
    * @returns {number}
    */
    static minimumRelayTransactionFee() {
        const ret = wasm.masscalculator_minimumRelayTransactionFee();
        return ret >>> 0;
    }
    /**
    * `maximumStandardTransactionMass()` is the maximum mass allowed for transactions that
    * are considered standard and will therefore be relayed and considered for mining.
    *
    * `pub const MAXIMUM_STANDARD_TRANSACTION_MASS: u64 = 100_000;`
    * @returns {number}
    */
    static maximumStandardTransactionMass() {
        const ret = wasm.masscalculator_maximumStandardTransactionMass();
        return ret >>> 0;
    }
    /**
    * minimum_required_transaction_relay_fee returns the minimum transaction fee required
    * for a transaction with the passed mass to be accepted into the mempool and relayed.
    * @param {number} mass
    * @returns {number}
    */
    static minimumRequiredTransactionRelayFee(mass) {
        const ret = wasm.masscalculator_minimumRequiredTransactionRelayFee(mass);
        return ret >>> 0;
    }
    /**
    * @param {any} tx
    * @returns {number}
    */
    calcMassForTransaction(tx) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.masscalculator_calcMassForTransaction(retptr, this.__wbg_ptr, addHeapObject(tx));
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return r0 >>> 0;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {number}
    */
    static blankTransactionSerializedByteSize() {
        const ret = wasm.masscalculator_blankTransactionSerializedByteSize();
        return ret >>> 0;
    }
    /**
    * @returns {number}
    */
    blankTransactionMass() {
        const ret = wasm.masscalculator_blankTransactionMass(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
    * @param {number} payload_byte_size
    * @returns {number}
    */
    calcMassForPayload(payload_byte_size) {
        const ret = wasm.masscalculator_calcMassForPayload(this.__wbg_ptr, payload_byte_size);
        return ret >>> 0;
    }
    /**
    * @param {any} outputs
    * @returns {number}
    */
    calcMassForOutputs(outputs) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.masscalculator_calcMassForOutputs(retptr, this.__wbg_ptr, addHeapObject(outputs));
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return r0 >>> 0;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @param {any} inputs
    * @returns {number}
    */
    calcMassForInputs(inputs) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.masscalculator_calcMassForInputs(retptr, this.__wbg_ptr, addHeapObject(inputs));
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return r0 >>> 0;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @param {TransactionOutput} output
    * @returns {number}
    */
    calcMassForOutput(output) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            _assertClass(output, TransactionOutput);
            wasm.masscalculator_calcMassForOutput(retptr, this.__wbg_ptr, output.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return r0 >>> 0;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @param {TransactionInput} input
    * @returns {number}
    */
    calcMassForInput(input) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            _assertClass(input, TransactionInput);
            wasm.masscalculator_calcMassForInput(retptr, this.__wbg_ptr, input.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return r0 >>> 0;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @param {number} minimum_signatures
    * @returns {number}
    */
    calcSignatureMass(minimum_signatures) {
        const ret = wasm.masscalculator_calcSignatureMass(this.__wbg_ptr, minimum_signatures);
        return ret >>> 0;
    }
    /**
    * @param {number} number_of_inputs
    * @param {number} minimum_signatures
    * @returns {number}
    */
    calcSignatureMassForInputs(number_of_inputs, minimum_signatures) {
        const ret = wasm.masscalculator_calcSignatureMassForInputs(this.__wbg_ptr, number_of_inputs, minimum_signatures);
        return ret >>> 0;
    }
    /**
    * @param {bigint} mass
    * @returns {number}
    */
    calcMinimumTransactionRelayFeeFromMass(mass) {
        const ret = wasm.masscalculator_calcMinimumTransactionRelayFeeFromMass(this.__wbg_ptr, mass);
        return ret >>> 0;
    }
    /**
    * @param {Transaction} transaction
    * @param {number} minimum_signatures
    * @returns {number}
    */
    calcMiniumTxRelayFee(transaction, minimum_signatures) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            _assertClass(transaction, Transaction);
            wasm.masscalculator_calcMiniumTxRelayFee(retptr, this.__wbg_ptr, transaction.__wbg_ptr, minimum_signatures);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return r0 >>> 0;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
module.exports.MassCalculator = MassCalculator;
/**
*/
class MkdtempSyncOptions {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(MkdtempSyncOptions.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_mkdtempsyncoptions_free(ptr);
    }
    /**
    * @param {string | undefined} encoding
    */
    constructor(encoding) {
        const ret = wasm.mkdtempsyncoptions_new_with_values(isLikeNone(encoding) ? 0 : addHeapObject(encoding));
        return MkdtempSyncOptions.__wrap(ret);
    }
    /**
    * @returns {MkdtempSyncOptions}
    */
    static new() {
        const ret = wasm.mkdtempsyncoptions_new();
        return MkdtempSyncOptions.__wrap(ret);
    }
    /**
    * @returns {string | undefined}
    */
    get encoding() {
        const ret = wasm.appendfileoptions_encoding(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {string | undefined} value
    */
    set encoding(value) {
        wasm.appendfileoptions_set_encoding(this.__wbg_ptr, isLikeNone(value) ? 0 : addHeapObject(value));
    }
}
module.exports.MkdtempSyncOptions = MkdtempSyncOptions;
/**
* BIP39 mnemonic phrases: sequences of words representing cryptographic keys.
*/
class Mnemonic {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(Mnemonic.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    toJSON() {
        return {
            entropy: this.entropy,
            phrase: this.phrase,
        };
    }

    toString() {
        return JSON.stringify(this);
    }

    [inspect.custom]() {
        return Object.assign(Object.create({constructor: this.constructor}), this.toJSON());
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_mnemonic_free(ptr);
    }
    /**
    * @param {string} phrase
    * @param {number | undefined} language
    */
    constructor(phrase, language) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(phrase, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
            const len0 = WASM_VECTOR_LEN;
            wasm.mnemonic_constructor(retptr, ptr0, len0, isLikeNone(language) ? 1 : language);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return Mnemonic.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {string}
    */
    get entropy() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.mnemonic_entropy(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * @param {string} entropy
    */
    set entropy(entropy) {
        const ptr0 = passStringToWasm0(entropy, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
        const len0 = WASM_VECTOR_LEN;
        wasm.mnemonic_set_entropy(this.__wbg_ptr, ptr0, len0);
    }
    /**
    * @returns {Mnemonic}
    */
    static random() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.mnemonic_random(retptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return Mnemonic.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {string}
    */
    get phrase() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.mnemonic_phrase(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * @param {string} phrase
    */
    set phrase(phrase) {
        const ptr0 = passStringToWasm0(phrase, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
        const len0 = WASM_VECTOR_LEN;
        wasm.mnemonic_set_phrase(this.__wbg_ptr, ptr0, len0);
    }
    /**
    * @param {string | undefined} password
    * @returns {string}
    */
    toSeed(password) {
        let deferred2_0;
        let deferred2_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            var ptr0 = isLikeNone(password) ? 0 : passStringToWasm0(password, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
            var len0 = WASM_VECTOR_LEN;
            wasm.mnemonic_toSeed(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred2_0 = r0;
            deferred2_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred2_0, deferred2_1, 1);
        }
    }
}
module.exports.Mnemonic = Mnemonic;
/**
*/
class NetServerOptions {

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_netserveroptions_free(ptr);
    }
    /**
    * @returns {boolean | undefined}
    */
    get allow_half_open() {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.netserveroptions_allow_half_open(ptr);
        return ret === 0xFFFFFF ? undefined : ret !== 0;
    }
    /**
    * @param {boolean | undefined} value
    */
    set allow_half_open(value) {
        const ptr = this.__destroy_into_raw();
        wasm.netserveroptions_set_allow_half_open(ptr, isLikeNone(value) ? 0xFFFFFF : value ? 1 : 0);
    }
    /**
    * @returns {boolean | undefined}
    */
    get pause_on_connect() {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.netserveroptions_pause_on_connect(ptr);
        return ret === 0xFFFFFF ? undefined : ret !== 0;
    }
    /**
    * @param {boolean | undefined} value
    */
    set pause_on_connect(value) {
        const ptr = this.__destroy_into_raw();
        wasm.netserveroptions_set_allow_half_open(ptr, isLikeNone(value) ? 0xFFFFFF : value ? 1 : 0);
    }
}
module.exports.NetServerOptions = NetServerOptions;
/**
*/
class NetworkId {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(NetworkId.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    toJSON() {
        return {
            type: this.type,
            suffix: this.suffix,
            id: this.id,
        };
    }

    toString() {
        return JSON.stringify(this);
    }

    [inspect.custom]() {
        return Object.assign(Object.create({constructor: this.constructor}), this.toJSON());
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_networkid_free(ptr);
    }
    /**
    * @returns {number}
    */
    get type() {
        const ret = wasm.__wbg_get_networkid_type(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
    * @param {number} arg0
    */
    set type(arg0) {
        wasm.__wbg_set_networkid_type(this.__wbg_ptr, arg0);
    }
    /**
    * @returns {number | undefined}
    */
    get suffix() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.__wbg_get_networkid_suffix(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            return r0 === 0 ? undefined : r1 >>> 0;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @param {number | undefined} arg0
    */
    set suffix(arg0) {
        wasm.__wbg_set_networkid_suffix(this.__wbg_ptr, !isLikeNone(arg0), isLikeNone(arg0) ? 0 : arg0);
    }
    /**
    * @param {any} value
    */
    constructor(value) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.networkid_ctor(retptr, addHeapObject(value));
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return NetworkId.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {string}
    */
    get id() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.networkid_id(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * @returns {string}
    */
    toString() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.networkid_id(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * @returns {string}
    */
    addressPrefix() {
        let deferred2_0;
        let deferred2_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.networkid_addressPrefix(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            var r3 = getInt32Memory0()[retptr / 4 + 3];
            var ptr1 = r0;
            var len1 = r1;
            if (r3) {
                ptr1 = 0; len1 = 0;
                throw takeObject(r2);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred2_0, deferred2_1, 1);
        }
    }
}
module.exports.NetworkId = NetworkId;
/**
*/
class PaymentOutput {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(PaymentOutput.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    toJSON() {
        return {
            address: this.address,
            amount: this.amount,
        };
    }

    toString() {
        return JSON.stringify(this);
    }

    [inspect.custom]() {
        return Object.assign(Object.create({constructor: this.constructor}), this.toJSON());
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_paymentoutput_free(ptr);
    }
    /**
    * @returns {Address}
    */
    get address() {
        const ret = wasm.__wbg_get_paymentoutput_address(this.__wbg_ptr);
        return Address.__wrap(ret);
    }
    /**
    * @param {Address} arg0
    */
    set address(arg0) {
        _assertClass(arg0, Address);
        var ptr0 = arg0.__destroy_into_raw();
        wasm.__wbg_set_paymentoutput_address(this.__wbg_ptr, ptr0);
    }
    /**
    * @returns {bigint}
    */
    get amount() {
        const ret = wasm.__wbg_get_paymentoutput_amount(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
    * @param {bigint} arg0
    */
    set amount(arg0) {
        wasm.__wbg_set_paymentoutput_amount(this.__wbg_ptr, arg0);
    }
    /**
    * @param {Address} address
    * @param {bigint} amount
    */
    constructor(address, amount) {
        _assertClass(address, Address);
        var ptr0 = address.__destroy_into_raw();
        const ret = wasm.paymentoutput_new(ptr0, amount);
        return PaymentOutput.__wrap(ret);
    }
}
module.exports.PaymentOutput = PaymentOutput;
/**
*/
class PaymentOutputs {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(PaymentOutputs.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_paymentoutputs_free(ptr);
    }
    /**
    * @param {any} output_array
    */
    constructor(output_array) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.paymentoutputs_constructor(retptr, addHeapObject(output_array));
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return PaymentOutputs.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
module.exports.PaymentOutputs = PaymentOutputs;
/**
*/
class PendingTransaction {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(PendingTransaction.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    toJSON() {
        return {
            id: this.id,
            paymentAmount: this.paymentAmount,
            changeAmount: this.changeAmount,
            feeAmount: this.feeAmount,
            aggregateInputAmount: this.aggregateInputAmount,
            aggregateOutputAmount: this.aggregateOutputAmount,
            type: this.type,
            addresses: this.addresses,
            transaction: this.transaction,
        };
    }

    toString() {
        return JSON.stringify(this);
    }

    [inspect.custom]() {
        return Object.assign(Object.create({constructor: this.constructor}), this.toJSON());
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_pendingtransaction_free(ptr);
    }
    /**
    * @returns {string}
    */
    get id() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.pendingtransaction_id(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * @returns {any}
    */
    get paymentAmount() {
        const ret = wasm.pendingtransaction_paymentAmount(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {bigint}
    */
    get changeAmount() {
        const ret = wasm.pendingtransaction_changeAmount(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {bigint}
    */
    get feeAmount() {
        const ret = wasm.pendingtransaction_feeAmount(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {bigint}
    */
    get aggregateInputAmount() {
        const ret = wasm.pendingtransaction_aggregateInputAmount(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {bigint}
    */
    get aggregateOutputAmount() {
        const ret = wasm.pendingtransaction_aggregateOutputAmount(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {string}
    */
    get type() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.pendingtransaction_type(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * @returns {Array<any>}
    */
    get addresses() {
        const ret = wasm.pendingtransaction_addresses(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {Array<any>}
    */
    getUtxoEntries() {
        const ret = wasm.pendingtransaction_getUtxoEntries(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * Sign transaction with supplied [`Array`] or [`PrivateKey`] or an array of
    * raw private key bytes (encoded as [`Uint8Array`] or as hex strings)
    * @param {any} js_value
    */
    sign(js_value) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.pendingtransaction_sign(retptr, this.__wbg_ptr, addHeapObject(js_value));
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            if (r1) {
                throw takeObject(r0);
            }
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * Submit transaction to the supplied [`RpcClient`]
    * @param {RpcClient} wasm_rpc_client
    * @returns {Promise<string>}
    */
    submit(wasm_rpc_client) {
        _assertClass(wasm_rpc_client, RpcClient);
        const ret = wasm.pendingtransaction_submit(this.__wbg_ptr, wasm_rpc_client.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * Returns encapsulated network [`Transaction`]
    * @returns {Transaction}
    */
    get transaction() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.pendingtransaction_transaction(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return Transaction.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
module.exports.PendingTransaction = PendingTransaction;
/**
*/
class PipeOptions {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(PipeOptions.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_pipeoptions_free(ptr);
    }
    /**
    * @param {boolean | undefined} end
    */
    constructor(end) {
        const ret = wasm.pipeoptions_new(isLikeNone(end) ? 0xFFFFFF : end ? 1 : 0);
        return PipeOptions.__wrap(ret);
    }
    /**
    * @returns {boolean | undefined}
    */
    get end() {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.netserveroptions_allow_half_open(ptr);
        return ret === 0xFFFFFF ? undefined : ret !== 0;
    }
    /**
    * @param {boolean | undefined} value
    */
    set end(value) {
        const ptr = this.__destroy_into_raw();
        wasm.netserveroptions_set_allow_half_open(ptr, isLikeNone(value) ? 0xFFFFFF : value ? 1 : 0);
    }
}
module.exports.PipeOptions = PipeOptions;
/**
* Data structure that envelops a Private Key
*/
class PrivateKey {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(PrivateKey.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_privatekey_free(ptr);
    }
    /**
    * Create a new [`PrivateKey`] from a hex-encoded string.
    * @param {string} key
    */
    constructor(key) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(key, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
            const len0 = WASM_VECTOR_LEN;
            wasm.privatekey_try_new(retptr, ptr0, len0);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return PrivateKey.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * Returns the [`PrivateKey`] key encoded as a hex string.
    * @returns {string}
    */
    toString() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.privatekey_toString(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * Generate a [`Keypair`] from this [`PrivateKey`].
    * @returns {Keypair}
    */
    toKeypair() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.keypair_fromPrivateKey(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return Keypair.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
module.exports.PrivateKey = PrivateKey;
/**
*/
class ProcessSendOptions {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(ProcessSendOptions.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_processsendoptions_free(ptr);
    }
    /**
    * @param {boolean | undefined} swallow_errors
    */
    constructor(swallow_errors) {
        const ret = wasm.processsendoptions_new(isLikeNone(swallow_errors) ? 0xFFFFFF : swallow_errors ? 1 : 0);
        return ProcessSendOptions.__wrap(ret);
    }
    /**
    * @returns {boolean | undefined}
    */
    get swallow_errors() {
        const ret = wasm.processsendoptions_swallow_errors(this.__wbg_ptr);
        return ret === 0xFFFFFF ? undefined : ret !== 0;
    }
    /**
    * @param {boolean | undefined} value
    */
    set swallow_errors(value) {
        wasm.processsendoptions_set_swallow_errors(this.__wbg_ptr, isLikeNone(value) ? 0xFFFFFF : value ? 1 : 0);
    }
}
module.exports.ProcessSendOptions = ProcessSendOptions;
/**
*/
class PrvKeyDataInfo {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(PrvKeyDataInfo.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_prvkeydatainfo_free(ptr);
    }
    /**
    * @returns {string}
    */
    get id() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.prvkeydatainfo_id(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * @returns {any}
    */
    get name() {
        const ret = wasm.prvkeydatainfo_name(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {any}
    */
    get isEncrypted() {
        const ret = wasm.prvkeydatainfo_isEncrypted(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {string} _name
    */
    setName(_name) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(_name, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
            const len0 = WASM_VECTOR_LEN;
            wasm.prvkeydatainfo_setName(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            if (r1) {
                throw takeObject(r0);
            }
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
module.exports.PrvKeyDataInfo = PrvKeyDataInfo;
/**
*/
class PubkeyDerivationManager {

    toJSON() {
        return {
            publicKey: this.publicKey,
        };
    }

    toString() {
        return JSON.stringify(this);
    }

    [inspect.custom]() {
        return Object.assign(Object.create({constructor: this.constructor}), this.toJSON());
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_pubkeyderivationmanager_free(ptr);
    }
    /**
    * @returns {string}
    */
    get publicKey() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.pubkeyderivationmanager_publicKey(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred1_0, deferred1_1, 1);
        }
    }
}
module.exports.PubkeyDerivationManager = PubkeyDerivationManager;
/**
*/
class PubkeyDerivationManagerV0 {

    toJSON() {
        return {
            publicKey: this.publicKey,
        };
    }

    toString() {
        return JSON.stringify(this);
    }

    [inspect.custom]() {
        return Object.assign(Object.create({constructor: this.constructor}), this.toJSON());
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_pubkeyderivationmanagerv0_free(ptr);
    }
    /**
    * @returns {string}
    */
    get publicKey() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.pubkeyderivationmanagerv0_publicKey(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred1_0, deferred1_1, 1);
        }
    }
}
module.exports.PubkeyDerivationManagerV0 = PubkeyDerivationManagerV0;
/**
*/
class PublicKey {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(PublicKey.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_publickey_free(ptr);
    }
    /**
    * Create a new [`PublicKey`] from a hex-encoded string.
    * @param {string} key
    */
    constructor(key) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(key, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
            const len0 = WASM_VECTOR_LEN;
            wasm.publickey_try_new(retptr, ptr0, len0);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return PublicKey.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {string}
    */
    toString() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.publickey_toString(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * Get the [`Address`] of this PublicKey.
    * Receives a [`NetworkType`] to determine the prefix of the address.
    * JavaScript: `let address = keypair.toAddress(NetworkType.MAINNET);`.
    * @param {NetworkType | NetworkId | string} network
    * @returns {Address}
    */
    toAddress(network) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.publickey_toAddress(retptr, this.__wbg_ptr, addHeapObject(network));
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return Address.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * Get `ECDSA` [`Address`] of this PublicKey.
    * Receives a [`NetworkType`] to determine the prefix of the address.
    * JavaScript: `let address = keypair.toAddress(NetworkType.MAINNET);`.
    * @param {NetworkType | NetworkId | string} network
    * @returns {Address}
    */
    toAddressECDSA(network) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.publickey_toAddressECDSA(retptr, this.__wbg_ptr, addHeapObject(network));
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return Address.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
module.exports.PublicKey = PublicKey;

class ReadStream {

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_readstream_free(ptr);
    }
    /**
    * @param {Function} listener
    * @returns {any}
    */
    add_listener_with_open(listener) {
        try {
            const ret = wasm.readstream_add_listener_with_open(this.__wbg_ptr, addBorrowedObject(listener));
            return takeObject(ret);
        } finally {
            heap[stack_pointer++] = undefined;
        }
    }
    /**
    * @param {Function} listener
    * @returns {any}
    */
    add_listener_with_close(listener) {
        try {
            const ret = wasm.readstream_add_listener_with_close(this.__wbg_ptr, addBorrowedObject(listener));
            return takeObject(ret);
        } finally {
            heap[stack_pointer++] = undefined;
        }
    }
    /**
    * @param {Function} listener
    * @returns {any}
    */
    on_with_open(listener) {
        try {
            const ret = wasm.readstream_on_with_open(this.__wbg_ptr, addBorrowedObject(listener));
            return takeObject(ret);
        } finally {
            heap[stack_pointer++] = undefined;
        }
    }
    /**
    * @param {Function} listener
    * @returns {any}
    */
    on_with_close(listener) {
        try {
            const ret = wasm.readstream_on_with_close(this.__wbg_ptr, addBorrowedObject(listener));
            return takeObject(ret);
        } finally {
            heap[stack_pointer++] = undefined;
        }
    }
    /**
    * @param {Function} listener
    * @returns {any}
    */
    once_with_open(listener) {
        try {
            const ret = wasm.readstream_once_with_open(this.__wbg_ptr, addBorrowedObject(listener));
            return takeObject(ret);
        } finally {
            heap[stack_pointer++] = undefined;
        }
    }
    /**
    * @param {Function} listener
    * @returns {any}
    */
    once_with_close(listener) {
        try {
            const ret = wasm.readstream_once_with_close(this.__wbg_ptr, addBorrowedObject(listener));
            return takeObject(ret);
        } finally {
            heap[stack_pointer++] = undefined;
        }
    }
    /**
    * @param {Function} listener
    * @returns {any}
    */
    prepend_listener_with_open(listener) {
        try {
            const ret = wasm.readstream_prepend_listener_with_open(this.__wbg_ptr, addBorrowedObject(listener));
            return takeObject(ret);
        } finally {
            heap[stack_pointer++] = undefined;
        }
    }
    /**
    * @param {Function} listener
    * @returns {any}
    */
    prepend_listener_with_close(listener) {
        try {
            const ret = wasm.readstream_prepend_listener_with_close(this.__wbg_ptr, addBorrowedObject(listener));
            return takeObject(ret);
        } finally {
            heap[stack_pointer++] = undefined;
        }
    }
    /**
    * @param {Function} listener
    * @returns {any}
    */
    prepend_once_listener_with_open(listener) {
        try {
            const ret = wasm.readstream_prepend_once_listener_with_open(this.__wbg_ptr, addBorrowedObject(listener));
            return takeObject(ret);
        } finally {
            heap[stack_pointer++] = undefined;
        }
    }
    /**
    * @param {Function} listener
    * @returns {any}
    */
    prepend_once_listener_with_close(listener) {
        try {
            const ret = wasm.readstream_prepend_once_listener_with_close(this.__wbg_ptr, addBorrowedObject(listener));
            return takeObject(ret);
        } finally {
            heap[stack_pointer++] = undefined;
        }
    }
}
module.exports.ReadStream = ReadStream;
/**
* Kaspa RPC client
*/
class RpcClient {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(RpcClient.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    toJSON() {
        return {
            url: this.url,
            open: this.open,
        };
    }

    toString() {
        return JSON.stringify(this);
    }

    [inspect.custom]() {
        return Object.assign(Object.create({constructor: this.constructor}), this.toJSON());
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rpcclient_free(ptr);
    }
    /**
    * Create a new RPC client with [`Encoding`] and a `url`.
    * @param {string} url
    * @param {number} encoding
    * @param {NetworkType | NetworkId | string | undefined} network_type
    */
    constructor(url, encoding, network_type) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(url, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
            const len0 = WASM_VECTOR_LEN;
            wasm.rpcclient_new(retptr, ptr0, len0, encoding, isLikeNone(network_type) ? 0 : addHeapObject(network_type));
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return RpcClient.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {string}
    */
    get url() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.rpcclient_url(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * @returns {boolean}
    */
    get open() {
        const ret = wasm.rpcclient_open(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
    * Connect to the Kaspa RPC server. This function starts a background
    * task that connects and reconnects to the server if the connection
    * is terminated.  Use [`disconnect()`] to terminate the connection.
    * @param {any} args
    * @returns {Promise<void>}
    */
    connect(args) {
        const ret = wasm.rpcclient_connect(this.__wbg_ptr, addHeapObject(args));
        return takeObject(ret);
    }
    /**
    * Disconnect from the Kaspa RPC server.
    * @returns {Promise<void>}
    */
    disconnect() {
        const ret = wasm.rpcclient_disconnect(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * Register a notification callback.
    * @param {any} callback
    * @returns {Promise<void>}
    */
    notify(callback) {
        const ret = wasm.rpcclient_notify(this.__wbg_ptr, addHeapObject(callback));
        return takeObject(ret);
    }
    /**
    * @param {number} encoding
    * @param {NetworkType | NetworkId | string} network
    * @returns {number}
    */
    static defaultPort(encoding, network) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.rpcclient_defaultPort(retptr, encoding, addHeapObject(network));
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return r0;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * Constructs an WebSocket RPC URL given the partial URL or an IP, RPC encoding
    * and a network type.
    *
    * # Arguments
    *
    * * `url` - Partial URL or an IP address
    * * `encoding` - RPC encoding
    * * `network_type` - Network type
    * @param {string} url
    * @param {number} encoding
    * @param {NetworkType | NetworkId | string} network
    * @returns {string}
    */
    static parseUrl(url, encoding, network) {
        let deferred3_0;
        let deferred3_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(url, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
            const len0 = WASM_VECTOR_LEN;
            wasm.rpcclient_parseUrl(retptr, ptr0, len0, encoding, addHeapObject(network));
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            var r3 = getInt32Memory0()[retptr / 4 + 3];
            var ptr2 = r0;
            var len2 = r1;
            if (r3) {
                ptr2 = 0; len2 = 0;
                throw takeObject(r2);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred3_0, deferred3_1, 1);
        }
    }
    /**
    * Subscription to DAA Score
    * @returns {Promise<void>}
    */
    subscribeDaaScore() {
        const ret = wasm.rpcclient_subscribeDaaScore(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * Unsubscribe from DAA Score
    * @returns {Promise<void>}
    */
    unsubscribeDaaScore() {
        const ret = wasm.rpcclient_unsubscribeDaaScore(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * Subscription to UTXOs Changed notifications
    * @param {any} addresses
    * @returns {Promise<void>}
    */
    subscribeUtxosChanged(addresses) {
        const ret = wasm.rpcclient_subscribeUtxosChanged(this.__wbg_ptr, addHeapObject(addresses));
        return takeObject(ret);
    }
    /**
    * Unsubscribe from DAA Score (test)
    * @param {any} addresses
    * @returns {Promise<void>}
    */
    unsubscribeUtxosChanged(addresses) {
        const ret = wasm.rpcclient_unsubscribeUtxosChanged(this.__wbg_ptr, addHeapObject(addresses));
        return takeObject(ret);
    }
    /**
    * @param {boolean} include_accepted_transaction_ids
    * @returns {Promise<void>}
    */
    subscribeVirtualChainChanged(include_accepted_transaction_ids) {
        const ret = wasm.rpcclient_subscribeVirtualChainChanged(this.__wbg_ptr, include_accepted_transaction_ids);
        return takeObject(ret);
    }
    /**
    * @param {boolean} include_accepted_transaction_ids
    * @returns {Promise<void>}
    */
    unsubscribeVirtualChainChanged(include_accepted_transaction_ids) {
        const ret = wasm.rpcclient_unsubscribeVirtualChainChanged(this.__wbg_ptr, include_accepted_transaction_ids);
        return takeObject(ret);
    }
    /**
    * @returns {Promise<void>}
    */
    subscribeBlockAdded() {
        const ret = wasm.rpcclient_subscribeBlockAdded(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {Promise<void>}
    */
    unsubscribeBlockAdded() {
        const ret = wasm.rpcclient_unsubscribeBlockAdded(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {Promise<void>}
    */
    subscribeFinalityConflict() {
        const ret = wasm.rpcclient_subscribeFinalityConflict(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {Promise<void>}
    */
    unsubscribeFinalityConflict() {
        const ret = wasm.rpcclient_unsubscribeFinalityConflict(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {Promise<void>}
    */
    subscribeFinalityConflictResolved() {
        const ret = wasm.rpcclient_subscribeFinalityConflictResolved(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {Promise<void>}
    */
    unsubscribeFinalityConflictResolved() {
        const ret = wasm.rpcclient_unsubscribeFinalityConflictResolved(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {Promise<void>}
    */
    subscribeSinkBlueScoreChanged() {
        const ret = wasm.rpcclient_subscribeSinkBlueScoreChanged(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {Promise<void>}
    */
    unsubscribeSinkBlueScoreChanged() {
        const ret = wasm.rpcclient_unsubscribeSinkBlueScoreChanged(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {Promise<void>}
    */
    subscribeVirtualDaaScoreChanged() {
        const ret = wasm.rpcclient_subscribeVirtualDaaScoreChanged(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {Promise<void>}
    */
    unsubscribeVirtualDaaScoreChanged() {
        const ret = wasm.rpcclient_unsubscribeVirtualDaaScoreChanged(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {Promise<void>}
    */
    subscribePruningPointUtxoSetOverride() {
        const ret = wasm.rpcclient_subscribePruningPointUtxoSetOverride(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {Promise<void>}
    */
    unsubscribePruningPointUtxoSetOverride() {
        const ret = wasm.rpcclient_unsubscribePruningPointUtxoSetOverride(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {Promise<void>}
    */
    subscribeNewBlockTemplate() {
        const ret = wasm.rpcclient_subscribeNewBlockTemplate(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {Promise<void>}
    */
    unsubscribeNewBlockTemplate() {
        const ret = wasm.rpcclient_unsubscribeNewBlockTemplate(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {Promise<any>}
    */
    getBlockCount() {
        const ret = wasm.rpcclient_getBlockCount(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {Promise<any>}
    */
    getBlockDagInfo() {
        const ret = wasm.rpcclient_getBlockDagInfo(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {Promise<any>}
    */
    getCoinSupply() {
        const ret = wasm.rpcclient_getCoinSupply(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {Promise<any>}
    */
    getConnectedPeerInfo() {
        const ret = wasm.rpcclient_getConnectedPeerInfo(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {Promise<any>}
    */
    getInfo() {
        const ret = wasm.rpcclient_getInfo(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {Promise<any>}
    */
    getPeerAddresses() {
        const ret = wasm.rpcclient_getPeerAddresses(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {Promise<any>}
    */
    getMetrics() {
        const ret = wasm.rpcclient_getMetrics(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {Promise<any>}
    */
    getSink() {
        const ret = wasm.rpcclient_getSink(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {Promise<any>}
    */
    getSinkBlueScore() {
        const ret = wasm.rpcclient_getSinkBlueScore(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {Promise<any>}
    */
    ping() {
        const ret = wasm.rpcclient_ping(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {Promise<any>}
    */
    shutdown() {
        const ret = wasm.rpcclient_shutdown(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {Promise<any>}
    */
    getServerInfo() {
        const ret = wasm.rpcclient_getServerInfo(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {Promise<any>}
    */
    getSyncStatus() {
        const ret = wasm.rpcclient_getSyncStatus(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {any} request
    * @returns {Promise<any>}
    */
    addPeer(request) {
        const ret = wasm.rpcclient_addPeer(this.__wbg_ptr, addHeapObject(request));
        return takeObject(ret);
    }
    /**
    * @param {any} request
    * @returns {Promise<any>}
    */
    ban(request) {
        const ret = wasm.rpcclient_ban(this.__wbg_ptr, addHeapObject(request));
        return takeObject(ret);
    }
    /**
    * @param {any} request
    * @returns {Promise<any>}
    */
    estimateNetworkHashesPerSecond(request) {
        const ret = wasm.rpcclient_estimateNetworkHashesPerSecond(this.__wbg_ptr, addHeapObject(request));
        return takeObject(ret);
    }
    /**
    * @param {any} request
    * @returns {Promise<any>}
    */
    getBalanceByAddress(request) {
        const ret = wasm.rpcclient_getBalanceByAddress(this.__wbg_ptr, addHeapObject(request));
        return takeObject(ret);
    }
    /**
    * @param {any} request
    * @returns {Promise<any>}
    */
    getBalancesByAddresses(request) {
        const ret = wasm.rpcclient_getBalancesByAddresses(this.__wbg_ptr, addHeapObject(request));
        return takeObject(ret);
    }
    /**
    * @param {any} request
    * @returns {Promise<any>}
    */
    getBlock(request) {
        const ret = wasm.rpcclient_getBlock(this.__wbg_ptr, addHeapObject(request));
        return takeObject(ret);
    }
    /**
    * @param {any} request
    * @returns {Promise<any>}
    */
    getBlocks(request) {
        const ret = wasm.rpcclient_getBlocks(this.__wbg_ptr, addHeapObject(request));
        return takeObject(ret);
    }
    /**
    * @param {any} request
    * @returns {Promise<any>}
    */
    getBlockTemplate(request) {
        const ret = wasm.rpcclient_getBlockTemplate(this.__wbg_ptr, addHeapObject(request));
        return takeObject(ret);
    }
    /**
    * @param {any} request
    * @returns {Promise<any>}
    */
    getCurrentNetwork(request) {
        const ret = wasm.rpcclient_getCurrentNetwork(this.__wbg_ptr, addHeapObject(request));
        return takeObject(ret);
    }
    /**
    * @param {any} request
    * @returns {Promise<any>}
    */
    getHeaders(request) {
        const ret = wasm.rpcclient_getHeaders(this.__wbg_ptr, addHeapObject(request));
        return takeObject(ret);
    }
    /**
    * @param {any} request
    * @returns {Promise<any>}
    */
    getMempoolEntries(request) {
        const ret = wasm.rpcclient_getMempoolEntries(this.__wbg_ptr, addHeapObject(request));
        return takeObject(ret);
    }
    /**
    * @param {any} request
    * @returns {Promise<any>}
    */
    getMempoolEntriesByAddresses(request) {
        const ret = wasm.rpcclient_getMempoolEntriesByAddresses(this.__wbg_ptr, addHeapObject(request));
        return takeObject(ret);
    }
    /**
    * @param {any} request
    * @returns {Promise<any>}
    */
    getMempoolEntry(request) {
        const ret = wasm.rpcclient_getMempoolEntry(this.__wbg_ptr, addHeapObject(request));
        return takeObject(ret);
    }
    /**
    * @param {any} request
    * @returns {Promise<any>}
    */
    getSubnetwork(request) {
        const ret = wasm.rpcclient_getSubnetwork(this.__wbg_ptr, addHeapObject(request));
        return takeObject(ret);
    }
    /**
    * @param {any} request
    * @returns {Promise<any>}
    */
    getVirtualChainFromBlock(request) {
        const ret = wasm.rpcclient_getVirtualChainFromBlock(this.__wbg_ptr, addHeapObject(request));
        return takeObject(ret);
    }
    /**
    * @param {any} request
    * @returns {Promise<any>}
    */
    resolveFinalityConflict(request) {
        const ret = wasm.rpcclient_resolveFinalityConflict(this.__wbg_ptr, addHeapObject(request));
        return takeObject(ret);
    }
    /**
    * @param {any} request
    * @returns {Promise<any>}
    */
    submitBlock(request) {
        const ret = wasm.rpcclient_submitBlock(this.__wbg_ptr, addHeapObject(request));
        return takeObject(ret);
    }
    /**
    * @param {any} request
    * @returns {Promise<any>}
    */
    unban(request) {
        const ret = wasm.rpcclient_unban(this.__wbg_ptr, addHeapObject(request));
        return takeObject(ret);
    }
    /**
    * @param {any} js_value
    * @param {boolean | undefined} allow_orphan
    * @returns {Promise<any>}
    */
    submitTransaction(js_value, allow_orphan) {
        const ret = wasm.rpcclient_submitTransaction(this.__wbg_ptr, addHeapObject(js_value), isLikeNone(allow_orphan) ? 0xFFFFFF : allow_orphan ? 1 : 0);
        return takeObject(ret);
    }
    /**
    * This call accepts an `Array` of `Address` or an Array of address strings.
    * @param {any} request
    * @returns {Promise<any>}
    */
    getUtxosByAddresses(request) {
        const ret = wasm.rpcclient_getUtxosByAddresses(this.__wbg_ptr, addHeapObject(request));
        return takeObject(ret);
    }
    /**
    * @param {any} request
    * @returns {Promise<any>}
    */
    getUtxosByAddressesCall(request) {
        const ret = wasm.rpcclient_getUtxosByAddressesCall(this.__wbg_ptr, addHeapObject(request));
        return takeObject(ret);
    }
}
module.exports.RpcClient = RpcClient;
/**
*
*  ScriptBuilder provides a facility for building custom scripts. It allows
* you to push opcodes, ints, and data while respecting canonical encoding. In
* general it does not ensure the script will execute correctly, however any
* data pushes which would exceed the maximum allowed script engine limits and
* are therefore guaranteed not to execute will not be pushed and will result in
* the Script function returning an error.
*/
class ScriptBuilder {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(ScriptBuilder.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_scriptbuilder_free(ptr);
    }
    /**
    * Get script bytes represented by a hex string.
    * @returns {string}
    */
    script() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.scriptbuilder_script(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * Drains (empties) the script builder, returning the
    * script bytes represented by a hex string.
    * @returns {string}
    */
    drain() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.scriptbuilder_drain(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * Pushes the passed opcode to the end of the script. The script will not
    * be modified if pushing the opcode would cause the script to exceed the
    * maximum allowed script engine size.
    * @param {number} opcode
    * @returns {ScriptBuilder}
    */
    addOp(opcode) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.scriptbuilder_addOp(retptr, this.__wbg_ptr, opcode);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return ScriptBuilder.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @param {any} opcodes
    * @returns {ScriptBuilder}
    */
    addOps(opcodes) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.scriptbuilder_addOps(retptr, this.__wbg_ptr, addHeapObject(opcodes));
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return ScriptBuilder.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * AddData pushes the passed data to the end of the script. It automatically
    * chooses canonical opcodes depending on the length of the data.
    *
    * A zero length buffer will lead to a push of empty data onto the stack (Op0 = OpFalse)
    * and any push of data greater than [`MAX_SCRIPT_ELEMENT_SIZE`] will not modify
    * the script since that is not allowed by the script engine.
    *
    * Also, the script will not be modified if pushing the data would cause the script to
    * exceed the maximum allowed script engine size [`MAX_SCRIPTS_SIZE`].
    * @param {any} data
    * @returns {ScriptBuilder}
    */
    addData(data) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.scriptbuilder_addData(retptr, this.__wbg_ptr, addHeapObject(data));
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return ScriptBuilder.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @param {bigint} val
    * @returns {ScriptBuilder}
    */
    addI64(val) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.scriptbuilder_addI64(retptr, this.__wbg_ptr, val);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return ScriptBuilder.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @param {bigint} lock_time
    * @returns {ScriptBuilder}
    */
    addLockTime(lock_time) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.scriptbuilder_addLockTime(retptr, this.__wbg_ptr, lock_time);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return ScriptBuilder.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @param {bigint} sequence
    * @returns {ScriptBuilder}
    */
    addSequence(sequence) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.scriptbuilder_addLockTime(retptr, this.__wbg_ptr, sequence);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return ScriptBuilder.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
module.exports.ScriptBuilder = ScriptBuilder;
/**
* Represents a Kaspad ScriptPublicKey
*/
class ScriptPublicKey {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(ScriptPublicKey.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    toJSON() {
        return {
            version: this.version,
            script: this.script,
        };
    }

    toString() {
        return JSON.stringify(this);
    }

    [inspect.custom]() {
        return Object.assign(Object.create({constructor: this.constructor}), this.toJSON());
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_scriptpublickey_free(ptr);
    }
    /**
    * @returns {number}
    */
    get version() {
        const ret = wasm.__wbg_get_scriptpublickey_version(this.__wbg_ptr);
        return ret;
    }
    /**
    * @param {number} arg0
    */
    set version(arg0) {
        wasm.__wbg_set_scriptpublickey_version(this.__wbg_ptr, arg0);
    }
    /**
    * @param {number} version
    * @param {any} script
    */
    constructor(version, script) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.scriptpublickey_constructor(retptr, version, addHeapObject(script));
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return ScriptPublicKey.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {string}
    */
    get script() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.scriptpublickey_script_as_hex(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred1_0, deferred1_1, 1);
        }
    }
}
module.exports.ScriptPublicKey = ScriptPublicKey;
/**
*/
class SetAadOptions {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(SetAadOptions.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_setaadoptions_free(ptr);
    }
    /**
    * @param {Function} flush
    * @param {number} plaintext_length
    * @param {Function} transform
    */
    constructor(flush, plaintext_length, transform) {
        const ret = wasm.setaadoptions_new(addHeapObject(flush), plaintext_length, addHeapObject(transform));
        return SetAadOptions.__wrap(ret);
    }
    /**
    * @returns {Function}
    */
    get flush() {
        const ret = wasm.setaadoptions_flush(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {Function} value
    */
    set flush(value) {
        wasm.setaadoptions_set_flush(this.__wbg_ptr, addHeapObject(value));
    }
    /**
    * @returns {number}
    */
    get plaintextLength() {
        const ret = wasm.setaadoptions_plaintextLength(this.__wbg_ptr);
        return ret;
    }
    /**
    * @param {number} value
    */
    set plaintext_length(value) {
        wasm.setaadoptions_set_plaintext_length(this.__wbg_ptr, value);
    }
    /**
    * @returns {Function}
    */
    get transform() {
        const ret = wasm.setaadoptions_transform(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {Function} value
    */
    set transform(value) {
        wasm.setaadoptions_set_transform(this.__wbg_ptr, addHeapObject(value));
    }
}
module.exports.SetAadOptions = SetAadOptions;
/**
* Represents a generic mutable transaction
*/
class SignableTransaction {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(SignableTransaction.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    toJSON() {
        return {
            entries: this.entries,
            tx: this.tx,
            inputs: this.inputs,
            outputs: this.outputs,
        };
    }

    toString() {
        return JSON.stringify(this);
    }

    [inspect.custom]() {
        return Object.assign(Object.create({constructor: this.constructor}), this.toJSON());
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_signabletransaction_free(ptr);
    }
    /**
    * UTXO entry data
    * @returns {UtxoEntries}
    */
    get entries() {
        const ret = wasm.__wbg_get_signabletransaction_entries(this.__wbg_ptr);
        return UtxoEntries.__wrap(ret);
    }
    /**
    * UTXO entry data
    * @param {UtxoEntries} arg0
    */
    set entries(arg0) {
        _assertClass(arg0, UtxoEntries);
        var ptr0 = arg0.__destroy_into_raw();
        wasm.__wbg_set_signabletransaction_entries(this.__wbg_ptr, ptr0);
    }
    /**
    * @param {Transaction} tx
    * @param {UtxoEntries} entries
    */
    constructor(tx, entries) {
        _assertClass(tx, Transaction);
        _assertClass(entries, UtxoEntries);
        const ret = wasm.signabletransaction_new_from_refs(tx.__wbg_ptr, entries.__wbg_ptr);
        return SignableTransaction.__wrap(ret);
    }
    /**
    * @returns {Transaction}
    */
    get tx() {
        const ret = wasm.signabletransaction_tx_getter(this.__wbg_ptr);
        return Transaction.__wrap(ret);
    }
    /**
    * @returns {string}
    */
    toJSON() {
        let deferred2_0;
        let deferred2_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.signabletransaction_toJSON(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            var r3 = getInt32Memory0()[retptr / 4 + 3];
            var ptr1 = r0;
            var len1 = r1;
            if (r3) {
                ptr1 = 0; len1 = 0;
                throw takeObject(r2);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred2_0, deferred2_1, 1);
        }
    }
    /**
    * @param {string} json
    * @returns {SignableTransaction}
    */
    static fromJSON(json) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(json, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
            const len0 = WASM_VECTOR_LEN;
            wasm.signabletransaction_fromJSON(retptr, ptr0, len0);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return SignableTransaction.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {any}
    */
    getScriptHashes() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.signabletransaction_getScriptHashes(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return takeObject(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @param {Array<any>} signatures
    * @returns {any}
    */
    setSignatures(signatures) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.signabletransaction_setSignatures(retptr, this.__wbg_ptr, addHeapObject(signatures));
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return takeObject(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {Array<any>}
    */
    get inputs() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.signabletransaction_get_inputs(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return takeObject(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {Array<any>}
    */
    get outputs() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.signabletransaction_get_outputs(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return takeObject(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
module.exports.SignableTransaction = SignableTransaction;
/**
*/
class State {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(State.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    toJSON() {
        return {
            target: this.target,
            prePowHash: this.prePowHash,
        };
    }

    toString() {
        return JSON.stringify(this);
    }

    [inspect.custom]() {
        return Object.assign(Object.create({constructor: this.constructor}), this.toJSON());
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_state_free(ptr);
    }
    /**
    * @param {Header} header
    */
    constructor(header) {
        _assertClass(header, Header);
        const ret = wasm.state_new(header.__wbg_ptr);
        return State.__wrap(ret);
    }
    /**
    * @returns {bigint}
    */
    get target() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.state_target(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return takeObject(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @param {any} nonce_jsv
    * @returns {Array<any>}
    */
    checkPow(nonce_jsv) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.state_checkPow(retptr, this.__wbg_ptr, addHeapObject(nonce_jsv));
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return takeObject(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {string}
    */
    get prePowHash() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.state_get_pre_pow_hash(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred1_0, deferred1_1, 1);
        }
    }
}
module.exports.State = State;
/**
* Wallet file storage interface
*/
class Storage {

    toJSON() {
        return {
            filename: this.filename,
        };
    }

    toString() {
        return JSON.stringify(this);
    }

    [inspect.custom]() {
        return Object.assign(Object.create({constructor: this.constructor}), this.toJSON());
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_storage_free(ptr);
    }
    /**
    * @returns {string}
    */
    get filename() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.storage_filename(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred1_0, deferred1_1, 1);
        }
    }
}
module.exports.Storage = Storage;
/**
*/
class StreamTransformOptions {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(StreamTransformOptions.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_streamtransformoptions_free(ptr);
    }
    /**
    * @param {Function} flush
    * @param {Function} transform
    */
    constructor(flush, transform) {
        const ret = wasm.streamtransformoptions_new(addHeapObject(flush), addHeapObject(transform));
        return StreamTransformOptions.__wrap(ret);
    }
    /**
    * @returns {Function}
    */
    get flush() {
        const ret = wasm.streamtransformoptions_flush(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {Function} value
    */
    set flush(value) {
        wasm.streamtransformoptions_set_flush(this.__wbg_ptr, addHeapObject(value));
    }
    /**
    * @returns {Function}
    */
    get transform() {
        const ret = wasm.streamtransformoptions_transform(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {Function} value
    */
    set transform(value) {
        wasm.streamtransformoptions_set_transform(this.__wbg_ptr, addHeapObject(value));
    }
}
module.exports.StreamTransformOptions = StreamTransformOptions;
/**
* Represents a Kaspa transaction
*/
class Transaction {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(Transaction.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    toJSON() {
        return {
            id: this.id,
            inputs: this.inputs,
            outputs: this.outputs,
            version: this.version,
            lock_time: this.lock_time,
            gas: this.gas,
            subnetworkId: this.subnetworkId,
            payload: this.payload,
        };
    }

    toString() {
        return JSON.stringify(this);
    }

    [inspect.custom]() {
        return Object.assign(Object.create({constructor: this.constructor}), this.toJSON());
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_transaction_free(ptr);
    }
    /**
    * Determines whether or not a transaction is a coinbase transaction. A coinbase
    * transaction is a special transaction created by miners that distributes fees and block subsidy
    * to the previous blocks' miners, and specifies the script_pub_key that will be used to pay the current
    * miner in future blocks.
    * @returns {boolean}
    */
    is_coinbase() {
        const ret = wasm.transaction_is_coinbase(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
    * Recompute and finalize the tx id based on updated tx fields
    * @returns {Hash}
    */
    finalize() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.transaction_finalize(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return Hash.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * Returns the transaction ID
    * @returns {string}
    */
    get id() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.transaction_id(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * @param {any} js_value
    */
    constructor(js_value) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.transaction_constructor(retptr, addHeapObject(js_value));
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return Transaction.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {Array<any>}
    */
    get inputs() {
        const ret = wasm.transaction_get_inputs_as_js_array(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {any} js_value
    */
    set inputs(js_value) {
        try {
            wasm.transaction_set_inputs_from_js_array(this.__wbg_ptr, addBorrowedObject(js_value));
        } finally {
            heap[stack_pointer++] = undefined;
        }
    }
    /**
    * @returns {Array<any>}
    */
    get outputs() {
        const ret = wasm.transaction_get_outputs_as_js_array(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {any} js_value
    */
    set outputs(js_value) {
        try {
            wasm.transaction_set_outputs_from_js_array(this.__wbg_ptr, addBorrowedObject(js_value));
        } finally {
            heap[stack_pointer++] = undefined;
        }
    }
    /**
    * @returns {number}
    */
    get version() {
        const ret = wasm.transaction_version(this.__wbg_ptr);
        return ret;
    }
    /**
    * @param {number} v
    */
    set version(v) {
        wasm.transaction_set_version(this.__wbg_ptr, v);
    }
    /**
    * @returns {bigint}
    */
    get lock_time() {
        const ret = wasm.transaction_gas(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
    * @param {bigint} v
    */
    set lock_time(v) {
        wasm.transaction_set_gas(this.__wbg_ptr, v);
    }
    /**
    * @returns {bigint}
    */
    get gas() {
        const ret = wasm.transaction_gas(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
    * @param {bigint} v
    */
    set gas(v) {
        wasm.transaction_set_gas(this.__wbg_ptr, v);
    }
    /**
    * @returns {string}
    */
    get subnetworkId() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.transaction_get_subnetwork_id_as_hex(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * @param {any} js_value
    */
    set subnetworkId(js_value) {
        wasm.transaction_set_subnetwork_id_from_js_value(this.__wbg_ptr, addHeapObject(js_value));
    }
    /**
    * @returns {string}
    */
    get payload() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.transaction_get_payload_as_hex_string(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * @param {any} js_value
    */
    set payload(js_value) {
        wasm.transaction_set_payload_from_js_value(this.__wbg_ptr, addHeapObject(js_value));
    }
}
module.exports.Transaction = Transaction;
/**
* Represents a Kaspa transaction input
*/
class TransactionInput {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(TransactionInput.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    toJSON() {
        return {
            previousOutpoint: this.previousOutpoint,
            signatureScript: this.signatureScript,
            sequence: this.sequence,
            sigOpCount: this.sigOpCount,
        };
    }

    toString() {
        return JSON.stringify(this);
    }

    [inspect.custom]() {
        return Object.assign(Object.create({constructor: this.constructor}), this.toJSON());
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_transactioninput_free(ptr);
    }
    /**
    * @param {any} js_value
    */
    constructor(js_value) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.transactioninput_constructor(retptr, addHeapObject(js_value));
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return TransactionInput.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {TransactionOutpoint}
    */
    get previousOutpoint() {
        const ret = wasm.transactioninput_get_previous_outpoint(this.__wbg_ptr);
        return TransactionOutpoint.__wrap(ret);
    }
    /**
    * @param {any} js_value
    */
    set previousOutpoint(js_value) {
        wasm.transactioninput_set_previous_outpoint(this.__wbg_ptr, addHeapObject(js_value));
    }
    /**
    * @returns {string}
    */
    get signatureScript() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.transactioninput_get_signature_script_as_hex(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * @param {any} js_value
    */
    set signatureScript(js_value) {
        wasm.transactioninput_set_signature_script_from_js_value(this.__wbg_ptr, addHeapObject(js_value));
    }
    /**
    * @returns {bigint}
    */
    get sequence() {
        const ret = wasm.transactioninput_get_sequence(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
    * @param {bigint} sequence
    */
    set sequence(sequence) {
        wasm.transactioninput_set_sequence(this.__wbg_ptr, sequence);
    }
    /**
    * @returns {number}
    */
    get sigOpCount() {
        const ret = wasm.transactioninput_get_sig_op_count(this.__wbg_ptr);
        return ret;
    }
    /**
    * @param {number} sig_op_count
    */
    set sigOpCount(sig_op_count) {
        wasm.transactioninput_set_sig_op_count(this.__wbg_ptr, sig_op_count);
    }
}
module.exports.TransactionInput = TransactionInput;
/**
* Represents a Kaspa transaction outpoint.
* NOTE: This struct is immutable - to create a custom outpoint
* use the `TransactionOutpoint::new` constructor. (in JavaScript
* use `new TransactionOutpoint(transactionId, index)`).
*/
class TransactionOutpoint {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(TransactionOutpoint.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    toJSON() {
        return {
            transactionId: this.transactionId,
            index: this.index,
        };
    }

    toString() {
        return JSON.stringify(this);
    }

    [inspect.custom]() {
        return Object.assign(Object.create({constructor: this.constructor}), this.toJSON());
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_transactionoutpoint_free(ptr);
    }
    /**
    * @param {Hash} transaction_id
    * @param {number} index
    */
    constructor(transaction_id, index) {
        _assertClass(transaction_id, Hash);
        var ptr0 = transaction_id.__destroy_into_raw();
        const ret = wasm.transactionoutpoint_new(ptr0, index);
        return TransactionOutpoint.__wrap(ret);
    }
    /**
    * @returns {string}
    */
    getId() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.transactionoutpoint_getId(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * @returns {string}
    */
    get transactionId() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.transactionoutpoint_transactionId(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * @returns {number}
    */
    get index() {
        const ret = wasm.transactionoutpoint_index(this.__wbg_ptr);
        return ret >>> 0;
    }
}
module.exports.TransactionOutpoint = TransactionOutpoint;
/**
* Represents a Kaspad transaction output
*/
class TransactionOutput {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(TransactionOutput.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    toJSON() {
        return {
            value: this.value,
            scriptPublicKey: this.scriptPublicKey,
        };
    }

    toString() {
        return JSON.stringify(this);
    }

    [inspect.custom]() {
        return Object.assign(Object.create({constructor: this.constructor}), this.toJSON());
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_transactionoutput_free(ptr);
    }
    /**
    * TransactionOutput constructor
    * @param {bigint} value
    * @param {ScriptPublicKey} script_public_key
    */
    constructor(value, script_public_key) {
        _assertClass(script_public_key, ScriptPublicKey);
        const ret = wasm.transactionoutput_new(value, script_public_key.__wbg_ptr);
        return TransactionOutput.__wrap(ret);
    }
    /**
    * @returns {bigint}
    */
    get value() {
        const ret = wasm.transactionoutput_value(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
    * @param {bigint} v
    */
    set value(v) {
        wasm.transactionoutput_set_value(this.__wbg_ptr, v);
    }
    /**
    * @returns {ScriptPublicKey}
    */
    get scriptPublicKey() {
        const ret = wasm.transactionoutput_scriptPublicKey(this.__wbg_ptr);
        return ScriptPublicKey.__wrap(ret);
    }
    /**
    * @param {ScriptPublicKey} v
    */
    set scriptPublicKey(v) {
        _assertClass(v, ScriptPublicKey);
        wasm.transactionoutput_set_scriptPublicKey(this.__wbg_ptr, v.__wbg_ptr);
    }
}
module.exports.TransactionOutput = TransactionOutput;
/**
*/
class TransactionOutputInner {

    toJSON() {
        return {
            value: this.value,
            scriptPublicKey: this.scriptPublicKey,
        };
    }

    toString() {
        return JSON.stringify(this);
    }

    [inspect.custom]() {
        return Object.assign(Object.create({constructor: this.constructor}), this.toJSON());
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_transactionoutputinner_free(ptr);
    }
    /**
    * @returns {bigint}
    */
    get value() {
        const ret = wasm.__wbg_get_transactionoutputinner_value(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
    * @param {bigint} arg0
    */
    set value(arg0) {
        wasm.__wbg_set_transactionoutputinner_value(this.__wbg_ptr, arg0);
    }
    /**
    * @returns {ScriptPublicKey}
    */
    get scriptPublicKey() {
        const ret = wasm.__wbg_get_transactionoutputinner_scriptPublicKey(this.__wbg_ptr);
        return ScriptPublicKey.__wrap(ret);
    }
    /**
    * @param {ScriptPublicKey} arg0
    */
    set scriptPublicKey(arg0) {
        _assertClass(arg0, ScriptPublicKey);
        var ptr0 = arg0.__destroy_into_raw();
        wasm.__wbg_set_transactionoutputinner_scriptPublicKey(this.__wbg_ptr, ptr0);
    }
}
module.exports.TransactionOutputInner = TransactionOutputInner;
/**
* Holds details about an individual transaction output in a utxo
* set such as whether or not it was contained in a coinbase tx, the daa
* score of the block that accepts the tx, its public key script, and how
* much it pays.
*/
class TxUtxoEntry {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(TxUtxoEntry.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    toJSON() {
        return {
            amount: this.amount,
            scriptPublicKey: this.scriptPublicKey,
            blockDaaScore: this.blockDaaScore,
            isCoinbase: this.isCoinbase,
        };
    }

    toString() {
        return JSON.stringify(this);
    }

    [inspect.custom]() {
        return Object.assign(Object.create({constructor: this.constructor}), this.toJSON());
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_txutxoentry_free(ptr);
    }
    /**
    * @returns {bigint}
    */
    get amount() {
        const ret = wasm.__wbg_get_txutxoentry_amount(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
    * @param {bigint} arg0
    */
    set amount(arg0) {
        wasm.__wbg_set_txutxoentry_amount(this.__wbg_ptr, arg0);
    }
    /**
    * @returns {ScriptPublicKey}
    */
    get scriptPublicKey() {
        const ret = wasm.__wbg_get_txutxoentry_scriptPublicKey(this.__wbg_ptr);
        return ScriptPublicKey.__wrap(ret);
    }
    /**
    * @param {ScriptPublicKey} arg0
    */
    set scriptPublicKey(arg0) {
        _assertClass(arg0, ScriptPublicKey);
        var ptr0 = arg0.__destroy_into_raw();
        wasm.__wbg_set_txutxoentry_scriptPublicKey(this.__wbg_ptr, ptr0);
    }
    /**
    * @returns {bigint}
    */
    get blockDaaScore() {
        const ret = wasm.__wbg_get_txutxoentry_blockDaaScore(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
    * @param {bigint} arg0
    */
    set blockDaaScore(arg0) {
        wasm.__wbg_set_txutxoentry_blockDaaScore(this.__wbg_ptr, arg0);
    }
    /**
    * @returns {boolean}
    */
    get isCoinbase() {
        const ret = wasm.__wbg_get_txutxoentry_isCoinbase(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
    * @param {boolean} arg0
    */
    set isCoinbase(arg0) {
        wasm.__wbg_set_txutxoentry_isCoinbase(this.__wbg_ptr, arg0);
    }
}
module.exports.TxUtxoEntry = TxUtxoEntry;
/**
*/
class UserInfoOptions {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(UserInfoOptions.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_userinfooptions_free(ptr);
    }
    /**
    * @param {string | undefined} encoding
    */
    constructor(encoding) {
        const ret = wasm.userinfooptions_new_with_values(isLikeNone(encoding) ? 0 : addHeapObject(encoding));
        return UserInfoOptions.__wrap(ret);
    }
    /**
    * @returns {UserInfoOptions}
    */
    static new() {
        const ret = wasm.userinfooptions_new();
        return UserInfoOptions.__wrap(ret);
    }
    /**
    * @returns {string | undefined}
    */
    get encoding() {
        const ret = wasm.formatinputpathobject_base(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {string | undefined} value
    */
    set encoding(value) {
        wasm.formatinputpathobject_set_base(this.__wbg_ptr, isLikeNone(value) ? 0 : addHeapObject(value));
    }
}
module.exports.UserInfoOptions = UserInfoOptions;
/**
*/
class UtxoContext {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(UtxoContext.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    toJSON() {
        return {
            balance: this.balance,
        };
    }

    toString() {
        return JSON.stringify(this);
    }

    [inspect.custom]() {
        return Object.assign(Object.create({constructor: this.constructor}), this.toJSON());
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_utxocontext_free(ptr);
    }
    /**
    * @param {any} js_value
    */
    constructor(js_value) {
        const ret = wasm.utxocontext_ctor(addHeapObject(js_value));
        return takeObject(ret);
    }
    /**
    * Performs a scan of the given addresses and registers them in the context for event notifications.
    * @param {any} addresses
    * @param {any} optional_current_daa_score
    * @returns {Promise<void>}
    */
    trackAddresses(addresses, optional_current_daa_score) {
        const ret = wasm.utxocontext_trackAddresses(this.__wbg_ptr, addHeapObject(addresses), addHeapObject(optional_current_daa_score));
        return takeObject(ret);
    }
    /**
    * Unregister a list of addresses from the context. This will stop tracking of these addresses.
    * @param {any} addresses
    * @returns {Promise<void>}
    */
    unregisterAddresses(addresses) {
        const ret = wasm.utxocontext_unregisterAddresses(this.__wbg_ptr, addHeapObject(addresses));
        return takeObject(ret);
    }
    /**
    * Clear the UtxoContext.  Unregisters all addresses and clears all UTXO entries.
    * @returns {Promise<void>}
    */
    clear() {
        const ret = wasm.utxocontext_clear(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * Returns the mature UTXO entries that are currently in the context.
    * @returns {Array<any>}
    */
    mature() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.utxocontext_mature(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return takeObject(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * Returns the mature UTXO entries that are currently in the context.
    * @returns {Array<any>}
    */
    pending() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.utxocontext_pending(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return takeObject(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {any}
    */
    get balance() {
        const ret = wasm.utxocontext_balance(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {Promise<Balance>}
    */
    updateBalance() {
        const ret = wasm.utxocontext_updateBalance(this.__wbg_ptr);
        return takeObject(ret);
    }
}
module.exports.UtxoContext = UtxoContext;
/**
* A simple collection of UTXO entries. This struct is used to
* retain a set of UTXO entries in the WASM memory for faster
* processing. This struct keeps a list of entries represented
* by `UtxoEntryReference` struct. This data structure is used
* internally by the framework, but is exposed for convenience.
* Please consider using `UtxoContect` instead.
*/
class UtxoEntries {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(UtxoEntries.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    toJSON() {
        return {
            items: this.items,
        };
    }

    toString() {
        return JSON.stringify(this);
    }

    [inspect.custom]() {
        return Object.assign(Object.create({constructor: this.constructor}), this.toJSON());
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_utxoentries_free(ptr);
    }
    /**
    * Create a new `UtxoEntries` struct with a set of entries.
    * @param {any} js_value
    */
    constructor(js_value) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.utxoentries_js_ctor(retptr, addHeapObject(js_value));
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return UtxoEntries.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {any}
    */
    get items() {
        const ret = wasm.utxoentries_get_items_as_js_array(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {any} js_value
    */
    set items(js_value) {
        try {
            wasm.utxoentries_set_items_from_js_array(this.__wbg_ptr, addBorrowedObject(js_value));
        } finally {
            heap[stack_pointer++] = undefined;
        }
    }
    /**
    * Sort the contained entries by amount. Please note that
    * this function is not intended for use with large UTXO sets
    * as it duplicates the whole contained UTXO set while sorting.
    */
    sort() {
        wasm.utxoentries_sort(this.__wbg_ptr);
    }
    /**
    * @returns {bigint}
    */
    amount() {
        const ret = wasm.utxoentries_amount(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
}
module.exports.UtxoEntries = UtxoEntries;
/**
*/
class UtxoEntry {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(UtxoEntry.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    toJSON() {
        return {
            address: this.address,
            outpoint: this.outpoint,
            entry: this.entry,
        };
    }

    toString() {
        return JSON.stringify(this);
    }

    [inspect.custom]() {
        return Object.assign(Object.create({constructor: this.constructor}), this.toJSON());
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_utxoentry_free(ptr);
    }
    /**
    * @returns {Address | undefined}
    */
    get address() {
        const ret = wasm.__wbg_get_utxoentry_address(this.__wbg_ptr);
        return ret === 0 ? undefined : Address.__wrap(ret);
    }
    /**
    * @param {Address | undefined} arg0
    */
    set address(arg0) {
        let ptr0 = 0;
        if (!isLikeNone(arg0)) {
            _assertClass(arg0, Address);
            ptr0 = arg0.__destroy_into_raw();
        }
        wasm.__wbg_set_utxoentry_address(this.__wbg_ptr, ptr0);
    }
    /**
    * @returns {TransactionOutpoint}
    */
    get outpoint() {
        const ret = wasm.__wbg_get_utxoentry_outpoint(this.__wbg_ptr);
        return TransactionOutpoint.__wrap(ret);
    }
    /**
    * @param {TransactionOutpoint} arg0
    */
    set outpoint(arg0) {
        _assertClass(arg0, TransactionOutpoint);
        var ptr0 = arg0.__destroy_into_raw();
        wasm.__wbg_set_utxoentry_outpoint(this.__wbg_ptr, ptr0);
    }
    /**
    * @returns {TxUtxoEntry}
    */
    get entry() {
        const ret = wasm.__wbg_get_utxoentry_entry(this.__wbg_ptr);
        return TxUtxoEntry.__wrap(ret);
    }
    /**
    * @param {TxUtxoEntry} arg0
    */
    set entry(arg0) {
        _assertClass(arg0, TxUtxoEntry);
        var ptr0 = arg0.__destroy_into_raw();
        wasm.__wbg_set_utxoentry_entry(this.__wbg_ptr, ptr0);
    }
}
module.exports.UtxoEntry = UtxoEntry;
/**
*/
class UtxoEntryReference {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(UtxoEntryReference.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    toJSON() {
        return {
            entry: this.entry,
            amount: this.amount,
            isCoinbase: this.isCoinbase,
            blockDaaScore: this.blockDaaScore,
        };
    }

    toString() {
        return JSON.stringify(this);
    }

    [inspect.custom]() {
        return Object.assign(Object.create({constructor: this.constructor}), this.toJSON());
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_utxoentryreference_free(ptr);
    }
    /**
    * @returns {UtxoEntry}
    */
    get entry() {
        const ret = wasm.utxoentryreference_entry(this.__wbg_ptr);
        return UtxoEntry.__wrap(ret);
    }
    /**
    * @returns {string}
    */
    getTransactionId() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.utxoentryreference_getTransactionId(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * @returns {string}
    */
    getId() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.utxoentryreference_getId(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * @returns {bigint}
    */
    get amount() {
        const ret = wasm.utxoentryreference_amount(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
    * @returns {boolean}
    */
    get isCoinbase() {
        const ret = wasm.utxoentryreference_isCoinbase(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
    * @returns {bigint}
    */
    get blockDaaScore() {
        const ret = wasm.utxoentryreference_blockDaaScore(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
}
module.exports.UtxoEntryReference = UtxoEntryReference;
/**
*/
class UtxoProcessor {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(UtxoProcessor.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    toJSON() {
        return {
            rpc: this.rpc,
            events: this.events,
        };
    }

    toString() {
        return JSON.stringify(this);
    }

    [inspect.custom]() {
        return Object.assign(Object.create({constructor: this.constructor}), this.toJSON());
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_utxoprocessor_free(ptr);
    }
    /**
    * @returns {RpcClient}
    */
    get rpc() {
        const ret = wasm.__wbg_get_utxoprocessor_rpc(this.__wbg_ptr);
        return RpcClient.__wrap(ret);
    }
    /**
    * @param {RpcClient} arg0
    */
    set rpc(arg0) {
        _assertClass(arg0, RpcClient);
        var ptr0 = arg0.__destroy_into_raw();
        wasm.__wbg_set_utxoprocessor_rpc(this.__wbg_ptr, ptr0);
    }
    /**
    * @returns {EventDispatcher}
    */
    get events() {
        const ret = wasm.__wbg_get_utxoprocessor_events(this.__wbg_ptr);
        return EventDispatcher.__wrap(ret);
    }
    /**
    * @param {EventDispatcher} arg0
    */
    set events(arg0) {
        _assertClass(arg0, EventDispatcher);
        var ptr0 = arg0.__destroy_into_raw();
        wasm.__wbg_set_utxoprocessor_events(this.__wbg_ptr, ptr0);
    }
    /**
    * @param {any} js_value
    */
    constructor(js_value) {
        const ret = wasm.utxoprocessor_ctor(addHeapObject(js_value));
        return takeObject(ret);
    }
    /**
    * @returns {Promise<void>}
    */
    shutdown() {
        const ret = wasm.utxoprocessor_shutdown(this.__wbg_ptr);
        return takeObject(ret);
    }
}
module.exports.UtxoProcessor = UtxoProcessor;
/**
*/
class Wallet {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(Wallet.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    toJSON() {
        return {
            rpc: this.rpc,
            events: this.events,
        };
    }

    toString() {
        return JSON.stringify(this);
    }

    [inspect.custom]() {
        return Object.assign(Object.create({constructor: this.constructor}), this.toJSON());
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wallet_free(ptr);
    }
    /**
    * @returns {RpcClient}
    */
    get rpc() {
        const ret = wasm.__wbg_get_utxoprocessor_rpc(this.__wbg_ptr);
        return RpcClient.__wrap(ret);
    }
    /**
    * @param {RpcClient} arg0
    */
    set rpc(arg0) {
        _assertClass(arg0, RpcClient);
        var ptr0 = arg0.__destroy_into_raw();
        wasm.__wbg_set_utxoprocessor_rpc(this.__wbg_ptr, ptr0);
    }
    /**
    * @returns {EventDispatcher}
    */
    get events() {
        const ret = wasm.__wbg_get_utxoprocessor_events(this.__wbg_ptr);
        return EventDispatcher.__wrap(ret);
    }
    /**
    * @param {EventDispatcher} arg0
    */
    set events(arg0) {
        _assertClass(arg0, EventDispatcher);
        var ptr0 = arg0.__destroy_into_raw();
        wasm.__wbg_set_utxoprocessor_events(this.__wbg_ptr, ptr0);
    }
    /**
    * @param {any} js_value
    */
    constructor(js_value) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.wallet_constructor(retptr, addHeapObject(js_value));
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return Wallet.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {Promise<any>}
    */
    keys() {
        const ret = wasm.wallet_keys(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {Promise<any>}
    */
    accounts() {
        const ret = wasm.wallet_accounts(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {any} prv_key_data_id_filter
    * @returns {Promise<any>}
    */
    accountIterator(prv_key_data_id_filter) {
        const ret = wasm.wallet_accountIterator(this.__wbg_ptr, addHeapObject(prv_key_data_id_filter));
        return takeObject(ret);
    }
    /**
    * @returns {boolean}
    */
    isOpen() {
        const ret = wasm.wallet_isOpen(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
    * @returns {boolean}
    */
    isSynced() {
        const ret = wasm.wallet_isSynced(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
    * @returns {any}
    */
    descriptor() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.wallet_descriptor(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return takeObject(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @param {any} name
    * @returns {Promise<boolean>}
    */
    exists(name) {
        const ret = wasm.wallet_exists(this.__wbg_ptr, addHeapObject(name));
        return takeObject(ret);
    }
    /**
    * @param {any} wallet_args
    * @returns {Promise<string>}
    */
    createWallet(wallet_args) {
        const ret = wasm.wallet_createWallet(this.__wbg_ptr, addHeapObject(wallet_args));
        return takeObject(ret);
    }
    /**
    * @param {any} args
    * @returns {Promise<object>}
    */
    createPrvKeyData(args) {
        const ret = wasm.wallet_createPrvKeyData(this.__wbg_ptr, addHeapObject(args));
        return takeObject(ret);
    }
    /**
    * @param {string} prv_key_data_id
    * @param {any} account_args
    * @returns {Promise<any>}
    */
    createAccount(prv_key_data_id, account_args) {
        const ptr0 = passStringToWasm0(prv_key_data_id, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wallet_createAccount(this.__wbg_ptr, ptr0, len0, addHeapObject(account_args));
        return takeObject(ret);
    }
    /**
    * @returns {Promise<boolean>}
    */
    ping() {
        const ret = wasm.wallet_ping(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {Promise<void>}
    */
    start() {
        const ret = wasm.wallet_start(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @returns {Promise<void>}
    */
    stop() {
        const ret = wasm.wallet_stop(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {any} args
    * @returns {Promise<void>}
    */
    connect(args) {
        const ret = wasm.wallet_connect(this.__wbg_ptr, addHeapObject(args));
        return takeObject(ret);
    }
    /**
    * @returns {Promise<void>}
    */
    disconnect() {
        const ret = wasm.wallet_disconnect(this.__wbg_ptr);
        return takeObject(ret);
    }
}
module.exports.Wallet = Wallet;
/**
*/
class WasiOptions {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(WasiOptions.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasioptions_free(ptr);
    }
    /**
    * @param {any[] | undefined} args
    * @param {object | undefined} env
    * @param {object} preopens
    */
    constructor(args, env, preopens) {
        var ptr0 = isLikeNone(args) ? 0 : passArrayJsValueToWasm0(args, wasm.__wbindgen_export_0);
        var len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasioptions_new_with_values(ptr0, len0, isLikeNone(env) ? 0 : addHeapObject(env), addHeapObject(preopens));
        return WasiOptions.__wrap(ret);
    }
    /**
    * @param {object} preopens
    * @returns {WasiOptions}
    */
    static new(preopens) {
        const ret = wasm.wasioptions_new(addHeapObject(preopens));
        return WasiOptions.__wrap(ret);
    }
    /**
    * @returns {any[] | undefined}
    */
    get args() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.wasioptions_args(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            let v1;
            if (r0 !== 0) {
                v1 = getArrayJsValueFromWasm0(r0, r1).slice();
                wasm.__wbindgen_export_9(r0, r1 * 4);
            }
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @param {any[] | undefined} value
    */
    set args(value) {
        var ptr0 = isLikeNone(value) ? 0 : passArrayJsValueToWasm0(value, wasm.__wbindgen_export_0);
        var len0 = WASM_VECTOR_LEN;
        wasm.wasioptions_set_args(this.__wbg_ptr, ptr0, len0);
    }
    /**
    * @returns {object | undefined}
    */
    get env() {
        const ret = wasm.wasioptions_env(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {object | undefined} value
    */
    set env(value) {
        wasm.wasioptions_set_env(this.__wbg_ptr, isLikeNone(value) ? 0 : addHeapObject(value));
    }
    /**
    * @returns {object}
    */
    get preopens() {
        const ret = wasm.wasioptions_preopens(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {object} value
    */
    set preopens(value) {
        wasm.wasioptions_set_preopens(this.__wbg_ptr, addHeapObject(value));
    }
}
module.exports.WasiOptions = WasiOptions;
/**
*/
class WriteFileSyncOptions {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(WriteFileSyncOptions.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_writefilesyncoptions_free(ptr);
    }
    /**
    * @param {string | undefined} encoding
    * @param {string | undefined} flag
    * @param {number | undefined} mode
    */
    constructor(encoding, flag, mode) {
        const ret = wasm.writefilesyncoptions_new(isLikeNone(encoding) ? 0 : addHeapObject(encoding), isLikeNone(flag) ? 0 : addHeapObject(flag), !isLikeNone(mode), isLikeNone(mode) ? 0 : mode);
        return WriteFileSyncOptions.__wrap(ret);
    }
    /**
    * @returns {string | undefined}
    */
    get encoding() {
        const ret = wasm.writefilesyncoptions_encoding(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {string | undefined} value
    */
    set encoding(value) {
        wasm.writefilesyncoptions_set_encoding(this.__wbg_ptr, isLikeNone(value) ? 0 : addHeapObject(value));
    }
    /**
    * @returns {string | undefined}
    */
    get flag() {
        const ret = wasm.writefilesyncoptions_flag(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
    * @param {string | undefined} value
    */
    set flag(value) {
        wasm.writefilesyncoptions_set_flag(this.__wbg_ptr, isLikeNone(value) ? 0 : addHeapObject(value));
    }
    /**
    * @returns {number | undefined}
    */
    get mode() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.writefilesyncoptions_mode(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            return r0 === 0 ? undefined : r1 >>> 0;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @param {number | undefined} value
    */
    set mode(value) {
        wasm.writefilesyncoptions_set_mode(this.__wbg_ptr, !isLikeNone(value), isLikeNone(value) ? 0 : value);
    }
}
module.exports.WriteFileSyncOptions = WriteFileSyncOptions;

class WriteStream {

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_writestream_free(ptr);
    }
    /**
    * @param {Function} listener
    * @returns {any}
    */
    add_listener_with_open(listener) {
        try {
            const ret = wasm.writestream_add_listener_with_open(this.__wbg_ptr, addBorrowedObject(listener));
            return takeObject(ret);
        } finally {
            heap[stack_pointer++] = undefined;
        }
    }
    /**
    * @param {Function} listener
    * @returns {any}
    */
    add_listener_with_close(listener) {
        try {
            const ret = wasm.writestream_add_listener_with_close(this.__wbg_ptr, addBorrowedObject(listener));
            return takeObject(ret);
        } finally {
            heap[stack_pointer++] = undefined;
        }
    }
    /**
    * @param {Function} listener
    * @returns {any}
    */
    on_with_open(listener) {
        try {
            const ret = wasm.writestream_on_with_open(this.__wbg_ptr, addBorrowedObject(listener));
            return takeObject(ret);
        } finally {
            heap[stack_pointer++] = undefined;
        }
    }
    /**
    * @param {Function} listener
    * @returns {any}
    */
    on_with_close(listener) {
        try {
            const ret = wasm.writestream_on_with_close(this.__wbg_ptr, addBorrowedObject(listener));
            return takeObject(ret);
        } finally {
            heap[stack_pointer++] = undefined;
        }
    }
    /**
    * @param {Function} listener
    * @returns {any}
    */
    once_with_open(listener) {
        try {
            const ret = wasm.writestream_once_with_open(this.__wbg_ptr, addBorrowedObject(listener));
            return takeObject(ret);
        } finally {
            heap[stack_pointer++] = undefined;
        }
    }
    /**
    * @param {Function} listener
    * @returns {any}
    */
    once_with_close(listener) {
        try {
            const ret = wasm.writestream_once_with_close(this.__wbg_ptr, addBorrowedObject(listener));
            return takeObject(ret);
        } finally {
            heap[stack_pointer++] = undefined;
        }
    }
    /**
    * @param {Function} listener
    * @returns {any}
    */
    prepend_listener_with_open(listener) {
        try {
            const ret = wasm.writestream_prepend_listener_with_open(this.__wbg_ptr, addBorrowedObject(listener));
            return takeObject(ret);
        } finally {
            heap[stack_pointer++] = undefined;
        }
    }
    /**
    * @param {Function} listener
    * @returns {any}
    */
    prepend_listener_with_close(listener) {
        try {
            const ret = wasm.writestream_prepend_listener_with_close(this.__wbg_ptr, addBorrowedObject(listener));
            return takeObject(ret);
        } finally {
            heap[stack_pointer++] = undefined;
        }
    }
    /**
    * @param {Function} listener
    * @returns {any}
    */
    prepend_once_listener_with_open(listener) {
        try {
            const ret = wasm.writestream_prepend_once_listener_with_open(this.__wbg_ptr, addBorrowedObject(listener));
            return takeObject(ret);
        } finally {
            heap[stack_pointer++] = undefined;
        }
    }
    /**
    * @param {Function} listener
    * @returns {any}
    */
    prepend_once_listener_with_close(listener) {
        try {
            const ret = wasm.writestream_prepend_once_listener_with_close(this.__wbg_ptr, addBorrowedObject(listener));
            return takeObject(ret);
        } finally {
            heap[stack_pointer++] = undefined;
        }
    }
}
module.exports.WriteStream = WriteStream;
/**
*/
class XPrivateKey {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(XPrivateKey.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_xprivatekey_free(ptr);
    }
    /**
    * @param {string} xprv
    * @param {boolean} is_multisig
    * @param {bigint} account_index
    * @param {number | undefined} cosigner_index
    */
    constructor(xprv, is_multisig, account_index, cosigner_index) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(xprv, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
            const len0 = WASM_VECTOR_LEN;
            wasm.xprivatekey_new(retptr, ptr0, len0, is_multisig, account_index, !isLikeNone(cosigner_index), isLikeNone(cosigner_index) ? 0 : cosigner_index);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return XPrivateKey.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @param {number} index
    * @returns {PrivateKey}
    */
    receiveKey(index) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.xprivatekey_receiveKey(retptr, this.__wbg_ptr, index);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return PrivateKey.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @param {number} index
    * @returns {PrivateKey}
    */
    changeKey(index) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.xprivatekey_changeKey(retptr, this.__wbg_ptr, index);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return PrivateKey.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
module.exports.XPrivateKey = XPrivateKey;
/**
*/
class XPrv {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(XPrv.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_xprv_free(ptr);
    }
    /**
    * @param {string} seed
    */
    constructor(seed) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(seed, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
            const len0 = WASM_VECTOR_LEN;
            wasm.xprv_new(retptr, ptr0, len0);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return XPrv.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @param {number} chile_number
    * @param {boolean | undefined} hardened
    * @returns {XPrv}
    */
    deriveChild(chile_number, hardened) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.xprv_deriveChild(retptr, this.__wbg_ptr, chile_number, isLikeNone(hardened) ? 0xFFFFFF : hardened ? 1 : 0);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return XPrv.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @param {any} path
    * @returns {XPrv}
    */
    derivePath(path) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.xprv_derivePath(retptr, this.__wbg_ptr, addHeapObject(path));
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return XPrv.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @param {string} prefix
    * @returns {string}
    */
    intoString(prefix) {
        let deferred3_0;
        let deferred3_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(prefix, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
            const len0 = WASM_VECTOR_LEN;
            wasm.xprv_intoString(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            var r3 = getInt32Memory0()[retptr / 4 + 3];
            var ptr2 = r0;
            var len2 = r1;
            if (r3) {
                ptr2 = 0; len2 = 0;
                throw takeObject(r2);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred3_0, deferred3_1, 1);
        }
    }
    /**
    * @returns {XPub}
    */
    publicKey() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.xprv_publicKey(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return XPub.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
module.exports.XPrv = XPrv;
/**
*/
class XPub {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(XPub.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_xpub_free(ptr);
    }
    /**
    * @param {string} xpub
    */
    constructor(xpub) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(xpub, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
            const len0 = WASM_VECTOR_LEN;
            wasm.xpub_new(retptr, ptr0, len0);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return XPub.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @param {number} chile_number
    * @param {boolean | undefined} hardened
    * @returns {XPub}
    */
    deriveChild(chile_number, hardened) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.xpub_deriveChild(retptr, this.__wbg_ptr, chile_number, isLikeNone(hardened) ? 0xFFFFFF : hardened ? 1 : 0);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return XPub.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @param {any} path
    * @returns {XPub}
    */
    derivePath(path) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.xpub_derivePath(retptr, this.__wbg_ptr, addHeapObject(path));
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            if (r2) {
                throw takeObject(r1);
            }
            return XPub.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @param {string} prefix
    * @returns {string}
    */
    intoString(prefix) {
        let deferred3_0;
        let deferred3_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(prefix, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
            const len0 = WASM_VECTOR_LEN;
            wasm.xpub_intoString(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            var r3 = getInt32Memory0()[retptr / 4 + 3];
            var ptr2 = r0;
            var len2 = r1;
            if (r3) {
                ptr2 = 0; len2 = 0;
                throw takeObject(r2);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export_9(deferred3_0, deferred3_1, 1);
        }
    }
}
module.exports.XPub = XPub;
/**
*/
class XPublicKey {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(XPublicKey.prototype);
        obj.__wbg_ptr = ptr;

        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;

        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_xpublickey_free(ptr);
    }
    /**
    * @param {string} kpub
    * @param {number | undefined} cosigner_index
    * @returns {Promise<XPublicKey>}
    */
    static fromXPub(kpub, cosigner_index) {
        const ptr0 = passStringToWasm0(kpub, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.xpublickey_fromXPub(ptr0, len0, !isLikeNone(cosigner_index), isLikeNone(cosigner_index) ? 0 : cosigner_index);
        return takeObject(ret);
    }
    /**
    * @param {string} xprv
    * @param {boolean} is_multisig
    * @param {bigint} account_index
    * @param {number | undefined} cosigner_index
    * @returns {Promise<XPublicKey>}
    */
    static fromMasterXPrv(xprv, is_multisig, account_index, cosigner_index) {
        const ptr0 = passStringToWasm0(xprv, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.xpublickey_fromMasterXPrv(ptr0, len0, is_multisig, account_index, !isLikeNone(cosigner_index), isLikeNone(cosigner_index) ? 0 : cosigner_index);
        return takeObject(ret);
    }
    /**
    * @param {number} start
    * @param {number} end
    * @returns {Promise<any>}
    */
    receivePubkeys(start, end) {
        const ret = wasm.xpublickey_receivePubkeys(this.__wbg_ptr, start, end);
        return takeObject(ret);
    }
    /**
    * @param {number} start
    * @param {number} end
    * @returns {Promise<any>}
    */
    changePubkeys(start, end) {
        const ret = wasm.xpublickey_changePubkeys(this.__wbg_ptr, start, end);
        return takeObject(ret);
    }
}
module.exports.XPublicKey = XPublicKey;

module.exports.__wbindgen_object_drop_ref = function(arg0) {
    takeObject(arg0);
};

module.exports.__wbindgen_object_clone_ref = function(arg0) {
    const ret = getObject(arg0);
    return addHeapObject(ret);
};

module.exports.__wbg_crypto_c48a774b022d20ac = function(arg0) {
    const ret = getObject(arg0).crypto;
    return addHeapObject(ret);
};

module.exports.__wbindgen_is_object = function(arg0) {
    const val = getObject(arg0);
    const ret = typeof(val) === 'object' && val !== null;
    return ret;
};

module.exports.__wbg_process_298734cf255a885d = function(arg0) {
    const ret = getObject(arg0).process;
    return addHeapObject(ret);
};

module.exports.__wbg_versions_e2e78e134e3e5d01 = function(arg0) {
    const ret = getObject(arg0).versions;
    return addHeapObject(ret);
};

module.exports.__wbg_node_1cd7a5d853dbea79 = function(arg0) {
    const ret = getObject(arg0).node;
    return addHeapObject(ret);
};

module.exports.__wbindgen_is_string = function(arg0) {
    const ret = typeof(getObject(arg0)) === 'string';
    return ret;
};

module.exports.__wbg_msCrypto_bcb970640f50a1e8 = function(arg0) {
    const ret = getObject(arg0).msCrypto;
    return addHeapObject(ret);
};

module.exports.__wbg_newwithlength_e5d69174d6984cd7 = function(arg0) {
    const ret = new Uint8Array(arg0 >>> 0);
    return addHeapObject(ret);
};

module.exports.__wbg_require_8f08ceecec0f4fee = function() { return handleError(function () {
    const ret = module.require;
    return addHeapObject(ret);
}, arguments) };

module.exports.__wbindgen_is_function = function(arg0) {
    const ret = typeof(getObject(arg0)) === 'function';
    return ret;
};

module.exports.__wbindgen_string_new = function(arg0, arg1) {
    const ret = getStringFromWasm0(arg0, arg1);
    return addHeapObject(ret);
};

module.exports.__wbg_call_01734de55d61e11d = function() { return handleError(function (arg0, arg1, arg2) {
    const ret = getObject(arg0).call(getObject(arg1), getObject(arg2));
    return addHeapObject(ret);
}, arguments) };

module.exports.__wbg_subarray_13db269f57aa838d = function(arg0, arg1, arg2) {
    const ret = getObject(arg0).subarray(arg1 >>> 0, arg2 >>> 0);
    return addHeapObject(ret);
};

module.exports.__wbg_getRandomValues_37fa2ca9e4e07fab = function() { return handleError(function (arg0, arg1) {
    getObject(arg0).getRandomValues(getObject(arg1));
}, arguments) };

module.exports.__wbindgen_memory = function() {
    const ret = wasm.memory;
    return addHeapObject(ret);
};

module.exports.__wbg_buffer_085ec1f694018c4f = function(arg0) {
    const ret = getObject(arg0).buffer;
    return addHeapObject(ret);
};

module.exports.__wbg_new_8125e318e6245eed = function(arg0) {
    const ret = new Uint8Array(getObject(arg0));
    return addHeapObject(ret);
};

module.exports.__wbg_set_5cf90238115182c3 = function(arg0, arg1, arg2) {
    getObject(arg0).set(getObject(arg1), arg2 >>> 0);
};

module.exports.__wbg_newwithbyteoffsetandlength_6da8e527659b86aa = function(arg0, arg1, arg2) {
    const ret = new Uint8Array(getObject(arg0), arg1 >>> 0, arg2 >>> 0);
    return addHeapObject(ret);
};

module.exports.__wbg_randomFillSync_dc1e9a60c158336d = function() { return handleError(function (arg0, arg1) {
    getObject(arg0).randomFillSync(takeObject(arg1));
}, arguments) };

module.exports.__wbg_get_97b561fb56f034b5 = function() { return handleError(function (arg0, arg1) {
    const ret = Reflect.get(getObject(arg0), getObject(arg1));
    return addHeapObject(ret);
}, arguments) };

module.exports.__wbg_now_0cfdc90c97d0c24b = function(arg0) {
    const ret = getObject(arg0).now();
    return ret;
};

module.exports.__wbg_get_44be0491f933a435 = function(arg0, arg1) {
    const ret = getObject(arg0)[arg1 >>> 0];
    return addHeapObject(ret);
};

module.exports.__wbg_length_fff51ee6522a1a18 = function(arg0) {
    const ret = getObject(arg0).length;
    return ret;
};

module.exports.__wbg_new_898a68150f225f2e = function() {
    const ret = new Array();
    return addHeapObject(ret);
};

module.exports.__wbg_next_ddb3312ca1c4e32a = function() { return handleError(function (arg0) {
    const ret = getObject(arg0).next();
    return addHeapObject(ret);
}, arguments) };

module.exports.__wbg_done_5c1f01fb660d73b5 = function(arg0) {
    const ret = getObject(arg0).done;
    return ret;
};

module.exports.__wbg_value_1695675138684bd5 = function(arg0) {
    const ret = getObject(arg0).value;
    return addHeapObject(ret);
};

module.exports.__wbg_iterator_97f0c81209c6c35a = function() {
    const ret = Symbol.iterator;
    return addHeapObject(ret);
};

module.exports.__wbg_call_cb65541d95d71282 = function() { return handleError(function (arg0, arg1) {
    const ret = getObject(arg0).call(getObject(arg1));
    return addHeapObject(ret);
}, arguments) };

module.exports.__wbg_next_526fc47e980da008 = function(arg0) {
    const ret = getObject(arg0).next;
    return addHeapObject(ret);
};

module.exports.__wbg_new_b51585de1b234aff = function() {
    const ret = new Object();
    return addHeapObject(ret);
};

module.exports.__wbg_self_1ff1d729e9aae938 = function() { return handleError(function () {
    const ret = self.self;
    return addHeapObject(ret);
}, arguments) };

module.exports.__wbg_window_5f4faef6c12b79ec = function() { return handleError(function () {
    const ret = window.window;
    return addHeapObject(ret);
}, arguments) };

module.exports.__wbg_globalThis_1d39714405582d3c = function() { return handleError(function () {
    const ret = globalThis.globalThis;
    return addHeapObject(ret);
}, arguments) };

module.exports.__wbg_global_651f05c6a0944d1c = function() { return handleError(function () {
    const ret = global.global;
    return addHeapObject(ret);
}, arguments) };

module.exports.__wbindgen_is_undefined = function(arg0) {
    const ret = getObject(arg0) === undefined;
    return ret;
};

module.exports.__wbg_newnoargs_581967eacc0e2604 = function(arg0, arg1) {
    const ret = new Function(getStringFromWasm0(arg0, arg1));
    return addHeapObject(ret);
};

module.exports.__wbg_set_502d29070ea18557 = function(arg0, arg1, arg2) {
    getObject(arg0)[arg1 >>> 0] = takeObject(arg2);
};

module.exports.__wbg_from_d7c216d4616bb368 = function(arg0) {
    const ret = Array.from(getObject(arg0));
    return addHeapObject(ret);
};

module.exports.__wbg_isArray_4c24b343cb13cfb1 = function(arg0) {
    const ret = Array.isArray(getObject(arg0));
    return ret;
};

module.exports.__wbg_push_ca1c26067ef907ac = function(arg0, arg1) {
    const ret = getObject(arg0).push(getObject(arg1));
    return ret;
};

module.exports.__wbg_instanceof_ArrayBuffer_39ac22089b74fddb = function(arg0) {
    let result;
    try {
        result = getObject(arg0) instanceof ArrayBuffer;
    } catch {
        result = false;
    }
    const ret = result;
    return ret;
};

module.exports.__wbg_BigInt_ff2599df450e2888 = function() { return handleError(function (arg0) {
    const ret = BigInt(getObject(arg0));
    return addHeapObject(ret);
}, arguments) };

module.exports.__wbg_BigInt_025925c4804d8575 = function(arg0) {
    const ret = BigInt(getObject(arg0));
    return addHeapObject(ret);
};

module.exports.__wbg_toString_2920606e1baa56d9 = function() { return handleError(function (arg0, arg1) {
    const ret = getObject(arg0).toString(arg1);
    return addHeapObject(ret);
}, arguments) };

module.exports.__wbg_toString_26c114c5f3052ff5 = function(arg0, arg1, arg2) {
    const ret = getObject(arg1).toString(arg2);
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
    const len1 = WASM_VECTOR_LEN;
    getInt32Memory0()[arg0 / 4 + 1] = len1;
    getInt32Memory0()[arg0 / 4 + 0] = ptr1;
};

module.exports.__wbg_newwithargs_a0432b7780c1dfa1 = function(arg0, arg1, arg2, arg3) {
    const ret = new Function(getStringFromWasm0(arg0, arg1), getStringFromWasm0(arg2, arg3));
    return addHeapObject(ret);
};

module.exports.__wbg_call_4c92f6aec1e1d6e6 = function() { return handleError(function (arg0, arg1, arg2, arg3) {
    const ret = getObject(arg0).call(getObject(arg1), getObject(arg2), getObject(arg3));
    return addHeapObject(ret);
}, arguments) };

module.exports.__wbg_instanceof_Map_41f4584cbc3ce79f = function(arg0) {
    let result;
    try {
        result = getObject(arg0) instanceof Map;
    } catch {
        result = false;
    }
    const ret = result;
    return ret;
};

module.exports.__wbg_entries_b5bd4a28ac6701ef = function(arg0) {
    const ret = getObject(arg0).entries();
    return addHeapObject(ret);
};

module.exports.__wbg_isSafeInteger_bb8e18dd21c97288 = function(arg0) {
    const ret = Number.isSafeInteger(getObject(arg0));
    return ret;
};

module.exports.__wbg_instanceof_Object_3daa8298c86298be = function(arg0) {
    let result;
    try {
        result = getObject(arg0) instanceof Object;
    } catch {
        result = false;
    }
    const ret = result;
    return ret;
};

module.exports.__wbg_entries_e51f29c7bba0c054 = function(arg0) {
    const ret = Object.entries(getObject(arg0));
    return addHeapObject(ret);
};

module.exports.__wbg_hasOwn_192ae478df6c20a8 = function(arg0, arg1) {
    const ret = Object.hasOwn(getObject(arg0), getObject(arg1));
    return ret;
};

module.exports.__wbg_keys_386d224d0262f361 = function(arg0) {
    const ret = Object.keys(getObject(arg0));
    return addHeapObject(ret);
};

module.exports.__wbg_new_43f1b47c28813cbd = function(arg0, arg1) {
    try {
        var state0 = {a: arg0, b: arg1};
        var cb0 = (arg0, arg1) => {
            const a = state0.a;
            state0.a = 0;
            try {
                return __wbg_adapter_157(a, state0.b, arg0, arg1);
            } finally {
                state0.a = a;
            }
        };
        const ret = new Promise(cb0);
        return addHeapObject(ret);
    } finally {
        state0.a = state0.b = 0;
    }
};

module.exports.__wbg_resolve_53698b95aaf7fcf8 = function(arg0) {
    const ret = Promise.resolve(getObject(arg0));
    return addHeapObject(ret);
};

module.exports.__wbg_then_f7e06ee3c11698eb = function(arg0, arg1) {
    const ret = getObject(arg0).then(getObject(arg1));
    return addHeapObject(ret);
};

module.exports.__wbg_then_b2267541e2a73865 = function(arg0, arg1, arg2) {
    const ret = getObject(arg0).then(getObject(arg1), getObject(arg2));
    return addHeapObject(ret);
};

module.exports.__wbg_length_72e2208bbc0efc61 = function(arg0) {
    const ret = getObject(arg0).length;
    return ret;
};

module.exports.__wbg_instanceof_Uint8Array_d8d9cb2b8e8ac1d4 = function(arg0) {
    let result;
    try {
        result = getObject(arg0) instanceof Uint8Array;
    } catch {
        result = false;
    }
    const ret = result;
    return ret;
};

module.exports.__wbindgen_debug_string = function(arg0, arg1) {
    const ret = debugString(getObject(arg1));
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
    const len1 = WASM_VECTOR_LEN;
    getInt32Memory0()[arg0 / 4 + 1] = len1;
    getInt32Memory0()[arg0 / 4 + 0] = ptr1;
};

module.exports.__wbindgen_string_get = function(arg0, arg1) {
    const obj = getObject(arg1);
    const ret = typeof(obj) === 'string' ? obj : undefined;
    var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
    var len1 = WASM_VECTOR_LEN;
    getInt32Memory0()[arg0 / 4 + 1] = len1;
    getInt32Memory0()[arg0 / 4 + 0] = ptr1;
};

module.exports.__wbg_set_092e06b0f9d71865 = function() { return handleError(function (arg0, arg1, arg2) {
    const ret = Reflect.set(getObject(arg0), getObject(arg1), getObject(arg2));
    return ret;
}, arguments) };

module.exports.__wbg_address_new = function(arg0) {
    const ret = Address.__wrap(arg0);
    return addHeapObject(ret);
};

module.exports.__wbindgen_is_falsy = function(arg0) {
    const ret = !getObject(arg0);
    return ret;
};

module.exports.__wbindgen_number_get = function(arg0, arg1) {
    const obj = getObject(arg1);
    const ret = typeof(obj) === 'number' ? obj : undefined;
    getFloat64Memory0()[arg0 / 8 + 1] = isLikeNone(ret) ? 0 : ret;
    getInt32Memory0()[arg0 / 4 + 0] = !isLikeNone(ret);
};

module.exports.__wbg_String_917f38a1211cf44b = function(arg0, arg1) {
    const ret = String(getObject(arg1));
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
    const len1 = WASM_VECTOR_LEN;
    getInt32Memory0()[arg0 / 4 + 1] = len1;
    getInt32Memory0()[arg0 / 4 + 0] = ptr1;
};

module.exports.__wbindgen_error_new = function(arg0, arg1) {
    const ret = new Error(getStringFromWasm0(arg0, arg1));
    return addHeapObject(ret);
};

module.exports.__wbindgen_is_array = function(arg0) {
    const ret = Array.isArray(getObject(arg0));
    return ret;
};

module.exports.__wbg_set_8761474ad72b9bf1 = function(arg0, arg1, arg2) {
    getObject(arg0)[takeObject(arg1)] = takeObject(arg2);
};

module.exports.__wbindgen_number_new = function(arg0) {
    const ret = arg0;
    return addHeapObject(ret);
};

module.exports.__wbindgen_bigint_from_u64 = function(arg0) {
    const ret = BigInt.asUintN(64, arg0);
    return addHeapObject(ret);
};

module.exports.__wbg_utxoentryreference_new = function(arg0) {
    const ret = UtxoEntryReference.__wrap(arg0);
    return addHeapObject(ret);
};

module.exports.__wbg_log_70ce39d4928deca4 = function(arg0, arg1) {
    console.log(getStringFromWasm0(arg0, arg1));
};

module.exports.__wbg_transactioninput_new = function(arg0) {
    const ret = TransactionInput.__wrap(arg0);
    return addHeapObject(ret);
};

module.exports.__wbg_transactionoutput_new = function(arg0) {
    const ret = TransactionOutput.__wrap(arg0);
    return addHeapObject(ret);
};

module.exports.__wbg_log_4f75fb60f4b955af = function(arg0, arg1) {
    console.log(getStringFromWasm0(arg0, arg1));
};

module.exports.__wbindgen_is_bigint = function(arg0) {
    const ret = typeof(getObject(arg0)) === 'bigint';
    return ret;
};

module.exports.__wbg_prvkeydatainfo_new = function(arg0) {
    const ret = PrvKeyDataInfo.__wrap(arg0);
    return addHeapObject(ret);
};

module.exports.__wbg_account_new = function(arg0) {
    const ret = Account.__wrap(arg0);
    return addHeapObject(ret);
};

module.exports.__wbg_error_a6f432a8a9e19b2b = function(arg0, arg1) {
    console.error(getStringFromWasm0(arg0, arg1));
};

module.exports.__wbg_warn_57fb6e43d435bbf8 = function(arg0, arg1) {
    console.warn(getStringFromWasm0(arg0, arg1));
};

module.exports.__wbindgen_ge = function(arg0, arg1) {
    const ret = getObject(arg0) >= getObject(arg1);
    return ret;
};

module.exports.__wbindgen_bigint_get_as_i64 = function(arg0, arg1) {
    const v = getObject(arg1);
    const ret = typeof(v) === 'bigint' ? v : undefined;
    getBigInt64Memory0()[arg0 / 8 + 1] = isLikeNone(ret) ? BigInt(0) : ret;
    getInt32Memory0()[arg0 / 4 + 0] = !isLikeNone(ret);
};

module.exports.__wbindgen_jsval_eq = function(arg0, arg1) {
    const ret = getObject(arg0) === getObject(arg1);
    return ret;
};

module.exports.__wbg_setonopen_419ca0e52d8f19e8 = function(arg0, arg1) {
    getObject(arg0).onopen = getObject(arg1);
};

module.exports.__wbg_setonclose_4210cf3908b79b31 = function(arg0, arg1) {
    getObject(arg0).onclose = getObject(arg1);
};

module.exports.__wbg_setonerror_2fa7120354e9ec15 = function(arg0, arg1) {
    getObject(arg0).onerror = getObject(arg1);
};

module.exports.__wbg_setonmessage_809f60b68c2a6938 = function(arg0, arg1) {
    getObject(arg0).onmessage = getObject(arg1);
};

module.exports.__wbg_close_dfa389d8fddb52fc = function() { return handleError(function (arg0) {
    getObject(arg0).close();
}, arguments) };

module.exports.__wbg_generatorsummary_new = function(arg0) {
    const ret = GeneratorSummary.__wrap(arg0);
    return addHeapObject(ret);
};

module.exports.__wbg_pendingtransaction_new = function(arg0) {
    const ret = PendingTransaction.__wrap(arg0);
    return addHeapObject(ret);
};

module.exports.__wbg_xpublickey_new = function(arg0) {
    const ret = XPublicKey.__wrap(arg0);
    return addHeapObject(ret);
};

module.exports.__wbg_utxoprocessor_new = function(arg0) {
    const ret = UtxoProcessor.__wrap(arg0);
    return addHeapObject(ret);
};

module.exports.__wbg_utxocontext_new = function(arg0) {
    const ret = UtxoContext.__wrap(arg0);
    return addHeapObject(ret);
};

module.exports.__wbg_balance_new = function(arg0) {
    const ret = Balance.__wrap(arg0);
    return addHeapObject(ret);
};

module.exports.__wbg_getItem_ed8e218e51f1efeb = function() { return handleError(function (arg0, arg1, arg2, arg3) {
    const ret = getObject(arg1).getItem(getStringFromWasm0(arg2, arg3));
    var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
    var len1 = WASM_VECTOR_LEN;
    getInt32Memory0()[arg0 / 4 + 1] = len1;
    getInt32Memory0()[arg0 / 4 + 0] = ptr1;
}, arguments) };

module.exports.__wbg_readFileSync_c812087d10d1e65d = function() { return handleError(function (arg0, arg1, arg2, arg3) {
    const ret = getObject(arg0).readFileSync(getStringFromWasm0(arg1, arg2), takeObject(arg3));
    return addHeapObject(ret);
}, arguments) };

module.exports.__wbg_existsSync_84fe9c0c4fdc18f9 = function() { return handleError(function (arg0, arg1, arg2) {
    const ret = getObject(arg0).existsSync(getStringFromWasm0(arg1, arg2));
    return ret;
}, arguments) };

module.exports.__wbg_setItem_d002ee486462bfff = function() { return handleError(function (arg0, arg1, arg2, arg3, arg4) {
    getObject(arg0).setItem(getStringFromWasm0(arg1, arg2), getStringFromWasm0(arg3, arg4));
}, arguments) };

module.exports.__wbg_writeFileSync_b78e85139c79a7ee = function() { return handleError(function (arg0, arg1, arg2, arg3, arg4) {
    getObject(arg0).writeFileSync(getStringFromWasm0(arg1, arg2), takeObject(arg3), takeObject(arg4));
}, arguments) };

module.exports.__wbg_length_cd7c64b4fa80547b = function() { return handleError(function (arg0) {
    const ret = getObject(arg0).length;
    return ret;
}, arguments) };

module.exports.__wbg_key_014e6584dcdd0954 = function() { return handleError(function (arg0, arg1, arg2) {
    const ret = getObject(arg1).key(arg2 >>> 0);
    var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
    var len1 = WASM_VECTOR_LEN;
    getInt32Memory0()[arg0 / 4 + 1] = len1;
    getInt32Memory0()[arg0 / 4 + 0] = ptr1;
}, arguments) };

module.exports.__wbg_mkdirSync_5ce69690fc3c9f98 = function() { return handleError(function (arg0, arg1, arg2, arg3) {
    getObject(arg0).mkdirSync(getStringFromWasm0(arg1, arg2), takeObject(arg3));
}, arguments) };

module.exports.__wbg_remove_074f1e68b70664fd = function() { return handleError(function (arg0, arg1) {
    let deferred0_0;
    let deferred0_1;
    try {
        deferred0_0 = arg0;
        deferred0_1 = arg1;
        const ret = chrome.storage.local.remove(getStringFromWasm0(arg0, arg1));
        return addHeapObject(ret);
    } finally {
        wasm.__wbindgen_export_9(deferred0_0, deferred0_1, 1);
    }
}, arguments) };

module.exports.__wbg_get_ca73db19e04a809d = function() { return handleError(function (arg0, arg1) {
    let deferred0_0;
    let deferred0_1;
    try {
        deferred0_0 = arg0;
        deferred0_1 = arg1;
        const ret = chrome.storage.local.get(getStringFromWasm0(arg0, arg1));
        return addHeapObject(ret);
    } finally {
        wasm.__wbindgen_export_9(deferred0_0, deferred0_1, 1);
    }
}, arguments) };

module.exports.__wbg_set_b66bd0119a539e9e = function() { return handleError(function (arg0) {
    const ret = chrome.storage.local.set(takeObject(arg0));
    return addHeapObject(ret);
}, arguments) };

module.exports.__wbg_readdir_9b4546420d367926 = function() { return handleError(function (arg0, arg1, arg2) {
    const ret = getObject(arg0).readdir(getStringFromWasm0(arg1, arg2));
    return addHeapObject(ret);
}, arguments) };

module.exports.__wbg_statSync_8e1d98020bee97c4 = function() { return handleError(function (arg0, arg1, arg2) {
    const ret = getObject(arg0).statSync(getStringFromWasm0(arg1, arg2));
    return addHeapObject(ret);
}, arguments) };

module.exports.__wbg_get_c45ca267bda2fb00 = function() { return handleError(function () {
    const ret = chrome.storage.local.get();
    return addHeapObject(ret);
}, arguments) };

module.exports.__wbg_removeItem_02359267b311cb85 = function() { return handleError(function (arg0, arg1, arg2) {
    getObject(arg0).removeItem(getStringFromWasm0(arg1, arg2));
}, arguments) };

module.exports.__wbg_unlinkSync_501600464b4dd65b = function() { return handleError(function (arg0, arg1, arg2) {
    getObject(arg0).unlinkSync(getStringFromWasm0(arg1, arg2));
}, arguments) };

module.exports.__wbindgen_is_null = function(arg0) {
    const ret = getObject(arg0) === null;
    return ret;
};

module.exports.__wbindgen_cb_drop = function(arg0) {
    const obj = takeObject(arg0).original;
    if (obj.cnt-- == 1) {
        obj.a = 0;
        return true;
    }
    const ret = false;
    return ret;
};

module.exports.__wbg_balancestrings_new = function(arg0) {
    const ret = BalanceStrings.__wrap(arg0);
    return addHeapObject(ret);
};

module.exports.__wbindgen_boolean_get = function(arg0) {
    const v = getObject(arg0);
    const ret = typeof(v) === 'boolean' ? (v ? 1 : 0) : 2;
    return ret;
};

module.exports.__wbg_location_56243dba507f472d = function(arg0) {
    const ret = getObject(arg0).location;
    return addHeapObject(ret);
};

module.exports.__wbg_protocol_91948f5885595359 = function() { return handleError(function (arg0, arg1) {
    const ret = getObject(arg1).protocol;
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
    const len1 = WASM_VECTOR_LEN;
    getInt32Memory0()[arg0 / 4 + 1] = len1;
    getInt32Memory0()[arg0 / 4 + 0] = ptr1;
}, arguments) };

module.exports.__wbindgen_jsval_loose_eq = function(arg0, arg1) {
    const ret = getObject(arg0) == getObject(arg1);
    return ret;
};

module.exports.__wbindgen_bigint_from_i64 = function(arg0) {
    const ret = arg0;
    return addHeapObject(ret);
};

module.exports.__wbindgen_in = function(arg0, arg1) {
    const ret = getObject(arg0) in getObject(arg1);
    return ret;
};

module.exports.__wbg_getwithrefkey_3b3c46ba20582127 = function(arg0, arg1) {
    const ret = getObject(arg0)[getObject(arg1)];
    return addHeapObject(ret);
};

module.exports.__wbg_toString_75fd4c6e5320868c = function(arg0, arg1, arg2, arg3, arg4, arg5) {
    const ret = getObject(arg0).toString(takeObject(arg1), arg2 === 0 ? undefined : arg3, arg4 === 0 ? undefined : arg5);
    return addHeapObject(ret);
};

module.exports.__wbg_on_5d61447a91633f13 = function(arg0, arg1, arg2, arg3) {
    const ret = getObject(arg0).on(getStringFromWasm0(arg1, arg2), getObject(arg3));
    return addHeapObject(ret);
};

module.exports.__wbg_addListener_ef6c129bb87219d9 = function(arg0, arg1, arg2, arg3) {
    const ret = getObject(arg0).addListener(getStringFromWasm0(arg1, arg2), getObject(arg3));
    return addHeapObject(ret);
};

module.exports.__wbg_once_73046d9a6e68af07 = function(arg0, arg1, arg2, arg3) {
    const ret = getObject(arg0).once(getStringFromWasm0(arg1, arg2), getObject(arg3));
    return addHeapObject(ret);
};

module.exports.__wbg_prependListener_c57792e09c18b9ac = function(arg0, arg1, arg2, arg3) {
    const ret = getObject(arg0).prependListener(getStringFromWasm0(arg1, arg2), getObject(arg3));
    return addHeapObject(ret);
};

module.exports.__wbg_prependOnceListener_56fb1130dde3be9d = function(arg0, arg1, arg2, arg3) {
    const ret = getObject(arg0).prependOnceListener(getStringFromWasm0(arg1, arg2), getObject(arg3));
    return addHeapObject(ret);
};

module.exports.__wbindgen_throw = function(arg0, arg1) {
    throw new Error(getStringFromWasm0(arg0, arg1));
};

module.exports.__wbg_body_674aec4c1c0910cd = function(arg0) {
    const ret = getObject(arg0).body;
    return isLikeNone(ret) ? 0 : addHeapObject(ret);
};

module.exports.__wbg_createElement_4891554b28d3388b = function() { return handleError(function (arg0, arg1, arg2) {
    const ret = getObject(arg0).createElement(getStringFromWasm0(arg1, arg2));
    return addHeapObject(ret);
}, arguments) };

module.exports.__wbg_innerHTML_7957d4fb76221e5a = function(arg0, arg1) {
    const ret = getObject(arg1).innerHTML;
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
    const len1 = WASM_VECTOR_LEN;
    getInt32Memory0()[arg0 / 4 + 1] = len1;
    getInt32Memory0()[arg0 / 4 + 0] = ptr1;
};

module.exports.__wbg_setinnerHTML_b089587252408b67 = function(arg0, arg1, arg2) {
    getObject(arg0).innerHTML = getStringFromWasm0(arg1, arg2);
};

module.exports.__wbg_removeAttribute_d8404da431968808 = function() { return handleError(function (arg0, arg1, arg2) {
    getObject(arg0).removeAttribute(getStringFromWasm0(arg1, arg2));
}, arguments) };

module.exports.__wbg_setAttribute_e7e80b478b7b8b2f = function() { return handleError(function (arg0, arg1, arg2, arg3, arg4) {
    getObject(arg0).setAttribute(getStringFromWasm0(arg1, arg2), getStringFromWasm0(arg3, arg4));
}, arguments) };

module.exports.__wbg_document_f7ace2b956f30a4f = function(arg0) {
    const ret = getObject(arg0).document;
    return isLikeNone(ret) ? 0 : addHeapObject(ret);
};

module.exports.__wbg_navigator_7c9103698acde322 = function(arg0) {
    const ret = getObject(arg0).navigator;
    return addHeapObject(ret);
};

module.exports.__wbg_localStorage_dbac11bd189e9fa0 = function() { return handleError(function (arg0) {
    const ret = getObject(arg0).localStorage;
    return isLikeNone(ret) ? 0 : addHeapObject(ret);
}, arguments) };

module.exports.__wbg_setbinaryType_096c70c4a9d97499 = function(arg0, arg1) {
    getObject(arg0).binaryType = takeObject(arg1);
};

module.exports.__wbg_new_b66404b6322c59bf = function() { return handleError(function (arg0, arg1) {
    const ret = new WebSocket(getStringFromWasm0(arg0, arg1));
    return addHeapObject(ret);
}, arguments) };

module.exports.__wbg_send_280c8ab5d0df82de = function() { return handleError(function (arg0, arg1, arg2) {
    getObject(arg0).send(getStringFromWasm0(arg1, arg2));
}, arguments) };

module.exports.__wbg_send_1a008ea2eb3a1951 = function() { return handleError(function (arg0, arg1, arg2) {
    getObject(arg0).send(getArrayU8FromWasm0(arg1, arg2));
}, arguments) };

module.exports.__wbg_data_ab99ae4a2e1e8bc9 = function(arg0) {
    const ret = getObject(arg0).data;
    return addHeapObject(ret);
};

module.exports.__wbg_instanceof_Window_9029196b662bc42a = function(arg0) {
    let result;
    try {
        result = getObject(arg0) instanceof Window;
    } catch {
        result = false;
    }
    const ret = result;
    return ret;
};

module.exports.__wbg_userAgent_2053026e2b1e0c7e = function() { return handleError(function (arg0, arg1) {
    const ret = getObject(arg1).userAgent;
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
    const len1 = WASM_VECTOR_LEN;
    getInt32Memory0()[arg0 / 4 + 1] = len1;
    getInt32Memory0()[arg0 / 4 + 0] = ptr1;
}, arguments) };

module.exports.__wbg_appendChild_51339d4cde00ee22 = function() { return handleError(function (arg0, arg1) {
    const ret = getObject(arg0).appendChild(getObject(arg1));
    return addHeapObject(ret);
}, arguments) };

module.exports.__wbg_isnodejs_748a3f25c165bacd = function(arg0) {
    const ret = getObject(arg0).is_node_js;
    return ret;
};

module.exports.__wbg_isnodewebkit_dfdb85a5caa186bb = function(arg0) {
    const ret = getObject(arg0).is_node_webkit;
    return ret;
};

module.exports.__wbg_requestAnimationFrame_0e5963260c9c9e01 = function(arg0) {
    const ret = requestAnimationFrame(takeObject(arg0));
    return addHeapObject(ret);
};

module.exports.__wbg_cancelAnimationFrame_f9856c2a6cf6b1ad = function(arg0) {
    cancelAnimationFrame(takeObject(arg0));
};

module.exports.__wbg_aborted_new = function(arg0) {
    const ret = Aborted.__wrap(arg0);
    return addHeapObject(ret);
};

module.exports.__wbg_setTimeout_edd887d0b98825d1 = function() { return handleError(function (arg0, arg1) {
    const ret = setTimeout(getObject(arg0), arg1 >>> 0);
    return addHeapObject(ret);
}, arguments) };

module.exports.__wbg_clearTimeout_55d984289e4d249a = function() { return handleError(function (arg0) {
    clearTimeout(getObject(arg0));
}, arguments) };

module.exports.__wbg_setInterval_074b084ea6ca5588 = function() { return handleError(function (arg0, arg1) {
    const ret = setInterval(getObject(arg0), arg1 >>> 0);
    return addHeapObject(ret);
}, arguments) };

module.exports.__wbg_clearInterval_53ba954bdfea137b = function() { return handleError(function (arg0) {
    clearInterval(getObject(arg0));
}, arguments) };

module.exports.__wbg_spawn_bbb498d786dabdaa = function(arg0, arg1, arg2, arg3, arg4) {
    const ret = getObject(arg0).spawn(getStringFromWasm0(arg1, arg2), getObject(arg3), getObject(arg4));
    return addHeapObject(ret);
};

module.exports.__wbg_stdout_fa9b02c7da382f3a = function(arg0) {
    const ret = getObject(arg0).stdout;
    return addHeapObject(ret);
};

module.exports.__wbg_stderr_1b3af8d2428b7c37 = function(arg0) {
    const ret = getObject(arg0).stderr;
    return addHeapObject(ret);
};

module.exports.__wbg_kill_4f38206bb09b1f94 = function(arg0) {
    const ret = getObject(arg0).kill();
    return ret;
};

module.exports.__wbg_kill_4be097c52636d50b = function(arg0, arg1) {
    const ret = getObject(arg0).kill(takeObject(arg1));
    return ret;
};

module.exports.__wbg_require_6a5feef9b98aef26 = function(arg0, arg1) {
    const ret = require(getStringFromWasm0(arg0, arg1));
    return addHeapObject(ret);
};

module.exports.__wbg_error_76579c6663c82e2f = function(arg0, arg1) {
    let deferred0_0;
    let deferred0_1;
    try {
        deferred0_0 = arg0;
        deferred0_1 = arg1;
        console.error(getStringFromWasm0(arg0, arg1));
    } finally {
        wasm.__wbindgen_export_9(deferred0_0, deferred0_1, 1);
    }
};

module.exports.__wbg_new_62fdcf9ea99bbffc = function() {
    const ret = new Error();
    return addHeapObject(ret);
};

module.exports.__wbg_stack_44dbc7208e0d27ff = function(arg0, arg1) {
    const ret = getObject(arg1).stack;
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
    const len1 = WASM_VECTOR_LEN;
    getInt32Memory0()[arg0 / 4 + 1] = len1;
    getInt32Memory0()[arg0 / 4 + 0] = ptr1;
};

module.exports.__wbg_asyncstreamproxy_new = function(arg0) {
    const ret = AsyncStreamProxy.__wrap(arg0);
    return addHeapObject(ret);
};

module.exports.__wbindgen_closure_wrapper9594 = function(arg0, arg1, arg2) {
    const ret = makeMutClosure(arg0, arg1, 3407, __wbg_adapter_56);
    return addHeapObject(ret);
};

module.exports.__wbindgen_closure_wrapper10102 = function(arg0, arg1, arg2) {
    const ret = makeMutClosure(arg0, arg1, 3446, __wbg_adapter_59);
    return addHeapObject(ret);
};

module.exports.__wbindgen_closure_wrapper10316 = function(arg0, arg1, arg2) {
    const ret = makeMutClosure(arg0, arg1, 3537, __wbg_adapter_62);
    return addHeapObject(ret);
};

module.exports.__wbindgen_closure_wrapper10764 = function(arg0, arg1, arg2) {
    const ret = makeMutClosure(arg0, arg1, 3720, __wbg_adapter_65);
    return addHeapObject(ret);
};

module.exports.__wbindgen_closure_wrapper10766 = function(arg0, arg1, arg2) {
    const ret = makeMutClosure(arg0, arg1, 3720, __wbg_adapter_68);
    return addHeapObject(ret);
};

module.exports.__wbindgen_closure_wrapper10768 = function(arg0, arg1, arg2) {
    const ret = makeMutClosure(arg0, arg1, 3720, __wbg_adapter_65);
    return addHeapObject(ret);
};

module.exports.__wbindgen_closure_wrapper10770 = function(arg0, arg1, arg2) {
    const ret = makeMutClosure(arg0, arg1, 3720, __wbg_adapter_65);
    return addHeapObject(ret);
};

const path = require('path').join(__dirname, 'kaspa_wasm_bg.wasm');
const bytes = require('fs').readFileSync(path);

const wasmModule = new WebAssembly.Module(bytes);
const wasmInstance = new WebAssembly.Instance(wasmModule, imports);
wasm = wasmInstance.exports;
module.exports.__wasm = wasm;

