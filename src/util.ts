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

export { TypedEventEmitter };
