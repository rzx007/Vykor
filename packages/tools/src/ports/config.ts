export interface ConfigToolPort {
  read(): Promise<object>;
  set(key: string, value: string): Promise<void>;
}
