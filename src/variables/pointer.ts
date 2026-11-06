/*
Copyright (C) 2023 Intel Corporation
SPDX-License-Identifier: MIT
*/
import assert = require("assert");
import { GetContextSymbolsCommand, TCFSymbolContextData, TCFTypeClass } from "../tcf-all";
import { SYM_FLAG_BIG_ENDIAN } from "./symbol";
import { AbstractVariable, ClientVariable, FixedNameProvider, NameProvider, RawValueProvider, VariableHelper } from "./types";

export class PointerVariable extends AbstractVariable {
    private childrenPromise: Promise<ClientVariable[]> | undefined;
    helper: VariableHelper;

    private displayValuePromise: Promise<string | undefined> | undefined;

    constructor(type: TCFSymbolContextData, symbolDetails: TCFSymbolContextData | undefined, nameProvider: NameProvider, valueProvider: RawValueProvider, helper: VariableHelper) {
        super(type, symbolDetails, nameProvider, valueProvider);
        this.helper = helper;
    }

    async getChildren() {
        return this.childrenPromise ??= this.loadChildren();
    }

    async loadChildren(): Promise<ClientVariable[]> {
        if (!this.type.BaseTypeID) {
            return [];
        }
        const bytes = await this.valueProvider.value();
        if (!bytes || ![1, 2, 4, 8].includes(bytes.length)) {
            throw new Error('Pointer value is unavailable or has an unsupported address width.');
        }
        const bigEndian = this.valueProvider.isBigEndian();
        const address = bytes.length === 8
            ? (bigEndian ? bytes.readBigUInt64BE() : bytes.readBigUInt64LE())
            : BigInt(bigEndian ? bytes.readUIntBE(0, bytes.length) : bytes.readUIntLE(0, bytes.length));
        if (address === 0n) {
            return [];
        }
        if (address > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new Error('Pointer address cannot be represented safely by TCF.');
        }
        const baseTypeDetails = await this.helper.sendCommand(new GetContextSymbolsCommand(this.type.BaseTypeID));
        if (baseTypeDetails.TypeClass === TCFTypeClass.function ||
            ((baseTypeDetails.TypeClass === undefined || baseTypeDetails.TypeClass === TCFTypeClass.unknown) && !baseTypeDetails.Size)) {
            return [];
        }
        const size = baseTypeDetails.Size;
        if (size === undefined || !Number.isSafeInteger(size) || size < 1) {
            throw new Error('Pointer target size is unavailable or invalid.');
        }
        let readPromise: Promise<Buffer> | undefined;
        const valueProvider: RawValueProvider = {
            value: () => readPromise ??= Promise.resolve().then(() => {
                if (!this.helper.readPointerMemory) {
                    throw new Error('Pointer memory reads are not available in this inspection context.');
                }
                return this.helper.readPointerMemory(Number(address), size);
            }),
            isBigEndian: () => baseTypeDetails.Flags === undefined
                ? bigEndian : (baseTypeDetails.Flags & SYM_FLAG_BIG_ENDIAN) !== 0,
        };
        const variable = this.helper.createVariable(baseTypeDetails, undefined, new FixedNameProvider("*"), valueProvider);
        return variable ? [variable] : [];
    }

    async displayValue(): Promise<string | undefined> {
        return this.displayValuePromise ??= this.loadValue();
    }

    async loadValue(): Promise<string | undefined> {
        const variableRawValue = await this.valueProvider.value();
        if (!variableRawValue) {
            return undefined;
        }

        assert(this.type.TypeClass === TCFTypeClass.pointer);
        const bigEndian = this.valueProvider.isBigEndian();
        let value: string;
        switch (variableRawValue.length) {
            case 8:
                value = '0x' + (bigEndian ? variableRawValue.readBigUInt64BE() : variableRawValue.readBigUInt64LE()).toString(16);
                break;
            case 4:
                value = '0x' + (bigEndian ? variableRawValue.readUInt32BE() : variableRawValue.readUInt32LE()).toString(16);
                break;
            case 2:
                value = '0x' + (bigEndian ? variableRawValue.readUInt16BE() : variableRawValue.readUInt16LE()).toString(16);
                break;
            case 1:
                value = '0x' + variableRawValue.readUInt8().toString(16);
                break;
            default:
                value = '0x' + variableRawValue.toString('hex');
                break;
        }
        return value;
    }

}
