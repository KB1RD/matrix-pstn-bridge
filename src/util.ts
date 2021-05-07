import * as EventEmitter from 'events';

class TypedEventEmitter<T extends FuncInterface> extends EventEmitter {
  constructor() {
    super();
  }
}

type FuncInterface = Record<string | symbol, (...args: any[]) => void>;

interface TypedListenerFunc<T extends FuncInterface, THIS> {
  <U extends keyof T>(
    event: U, listener: T[U]
  ): THIS;
}
interface TypedEmitFunc<T extends FuncInterface> {
  <U extends keyof T>(
    event: U, ...args: Parameters<T[U]>
  ): boolean;
}
declare interface TypedEventEmitter<T extends FuncInterface> {
  on: TypedListenerFunc<T, this>;
  off: TypedListenerFunc<T, this>;
  addListener: TypedListenerFunc<T, this>;
  once: TypedListenerFunc<T, this>;
  prependListener: TypedListenerFunc<T, this>;
  prependOnceListener: TypedListenerFunc<T, this>;
  removeListener: TypedListenerFunc<T, this>;

  emit: TypedEmitFunc<T>;
}

/**
 * Like a map, but takes exclusively tuples. I can't find a way to enforce this
 * with TS, but you **must** use a fixed length tuple for the `K` type.
 */
export class TupleLookup<K extends any[], V> {
  /**
   * This is damn impossible to type, so I'm not going to. Enjoy.
   */
  protected base_map = new Map<unknown, unknown>();
  get(key: K): V | undefined {
    let map: Map<unknown, unknown> = this.base_map;
    for (const el of key) {
      map = map.get(el) as Map<unknown, unknown>;
      if (!map) {
        return undefined;
      }
    }
    return map as unknown as V;
  }
  set(key: K, value: V | undefined): this {
    let map = this.base_map;
    let tmp: Map<unknown, unknown>;
    for (const el of key.slice(0, key.length - 1)) {
      tmp = map.get(el) as Map<unknown, unknown>;
      if (!tmp) {
        tmp = new Map<unknown, unknown>();
        map.set(el, tmp);
      }
      map = tmp;
    }
    if (value === undefined) {
      map.delete(key[key.length - 1]);
    } else {
      map.set(key[key.length - 1], value);
    }
    return this;
  }
  has(key: K): boolean {
    return Boolean(this.get(key));
  }
  delete(key: K): this {
    this.set(key, undefined);
    return this;
  }
}

export { TypedEventEmitter };
