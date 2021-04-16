import { IStorageProvider, IAppserviceStorageProvider, IFilterInfo } from 'matrix-bot-sdk';
import * as SqliteDB from 'better-sqlite3';
import * as sha512 from 'hash.js/lib/hash/sha/512';
import * as Str from '@supercharge/strings';

export interface IControlConfig {
  number: string;
  module: string;
  moddata: object;
};

export interface IBridgedRoomConfig {
  remote_number: string;
  control_room: string;
};
export interface IBridgedRoomConfigWithControl extends IBridgedRoomConfig {
  control_config: IControlConfig | null;
};

export interface IBridgeDatabase extends IStorageProvider, IAppserviceStorageProvider {
  /**
   * Gets the config data for a control room.
   */
  getControlRoomConfig(room: string): Promise<IControlConfig | null>;
  /**
   * Sets the config data for a control room.
   */
  setControlRoomConfig(room: string, config: IControlConfig | null): Promise<void>;
  // getControlRoomForNumber(number: string): Promise<[string, IControlConfig] | null>;

  /**
   * Gets the config data for a bridged room.
   */
  getBridgedRoomConfig(room: string): Promise<IBridgedRoomConfigWithControl | null>;
  /**
   * Sets the config data for a bridged room.
   */
  setBridgedRoomConfig(room: string, config: IBridgedRoomConfig | null): Promise<void>;
  /**
   * Gets the bridge room that corresponds to a number for a particular control
   * room ID.
   */
  getBridgedRoomForNumber(control: string, number: string): Promise<string | null>;

  /**
   * Creates a random webhook token for a control room. Will overwrite any
   * existing tokens for that control room if present.
   */
  createWebhookToken(control: string): Promise<string>;
  /**
   * Gets the control room corresponding to a webhook token, or `null`.
   */
  getControlRoomFromWebhookToken(token: string): Promise<string | null>;
  /**
   * Invalidates a webhook token.
   */
  deleteWebhookToken(control: string): Promise<void>;
}

export class SqliteBridgeDatabase implements IBridgeDatabase {
  protected db: SqliteDB.Database;
  
  protected txns = new Set<string>();

  protected stmt_getctrlconfig: SqliteDB.Statement<{ room: string }>;
  protected stmt_insctrlconfig: SqliteDB.Statement<IControlConfig & { room: string }>;
  protected stmt_delctrlconfig: SqliteDB.Statement<{ room: string }>;

  protected stmt_getbrroom: SqliteDB.Statement<{ room: string }>;
  protected stmt_insbrroom: SqliteDB.Statement<IBridgedRoomConfig & { room: string }>;
  protected stmt_delbrroom: SqliteDB.Statement<{ room: string }>;
  protected stmt_getbrroom_num: SqliteDB.Statement<{ control: string, number: string }>;

  protected stmt_inswht: SqliteDB.Statement<{ control: string, hook: string }>;
  protected stmt_getwht: SqliteDB.Statement<{ hook: string }>;
  protected stmt_delwht: SqliteDB.Statement<{ control: string }>;
  
  protected kvstore_get: (k: string) => string | null
  protected kvstore_set: (k: string, v: string | null) => void

  constructor({ file }: { file: string }) {
    this.db = new SqliteDB(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS control_rooms (
        id TEXT PRIMARY KEY NOT NULL,
        number TEXT NOT NULL,
        module TEXT NOT NULL,
        moddata TEXT NOT NULL,
        UNIQUE (id)
      );

      CREATE TABLE IF NOT EXISTS bridged_rooms (
        id TEXT PRIMARY KEY NOT NULL,
        control_room TEXT NOT NULL,
        remote_number TEXT NOT NULL,
        UNIQUE (id),
        UNIQUE (control_room, remote_number)
      );

      CREATE TABLE IF NOT EXISTS webhooks (
        control TEXT PRIMARY KEY NOT NULL,
        hook TEXT NOT NULL,
        UNIQUE (control),
        UNIQUE (hook)
      );

      CREATE TABLE IF NOT EXISTS kvstore (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        UNIQUE (key)
      );
    `);

    this.stmt_getctrlconfig = this.db.prepare('SELECT number, module, moddata FROM control_rooms WHERE id = $room');
    this.stmt_insctrlconfig = this.db.prepare('INSERT INTO control_rooms VALUES ($room, $number, $module, $moddata)');
    this.stmt_delctrlconfig = this.db.prepare('DELETE FROM control_rooms WHERE id = $room');
    this.setControlRoomConfig = this.db.transaction(async (room: string, config: IControlConfig | null): Promise<void> => {
      this.stmt_delctrlconfig.run({ room });
      if (config) {
        this.stmt_insctrlconfig.run(
          Object.assign(
            config,
            { room, moddata: config && JSON.stringify(config.moddata) },
          ),
        );
      }
    });

    this.stmt_getbrroom = this.db.prepare('SELECT remote_number, control_room FROM bridged_rooms WHERE id = $room');
    this.getBridgedRoomConfig = this.db.transaction(async (room: string): Promise<IBridgedRoomConfigWithControl | null> => {
      const cfg: IBridgedRoomConfigWithControl | null = this.stmt_getbrroom.get({ room });
      if (cfg) {
        cfg.control_config = await this.getControlRoomConfig(cfg.control_room);
      }
      return cfg;
    });
    this.stmt_insbrroom = this.db.prepare('INSERT INTO bridged_rooms VALUES ($room, $control_room, $remote_number)');
    this.stmt_delbrroom = this.db.prepare('DELETE FROM bridged_rooms WHERE id = $room');
    this.setBridgedRoomConfig = this.db.transaction(async (room: string, config: IBridgedRoomConfig | null): Promise<void> => {
      this.stmt_delbrroom.run({ room });
      if (config) {
        this.stmt_insbrroom.run(Object.assign(config, { room }));
      }
    });
    this.stmt_getbrroom_num = this.db.prepare('SELECT id FROM bridged_rooms WHERE control_room = $control AND remote_number = $number');

    this.stmt_inswht = this.db.prepare('INSERT INTO webhooks VALUES ($control, $hook)');
    this.stmt_getwht = this.db.prepare('SELECT control FROM webhooks WHERE hook = $hook');
    this.stmt_delwht = this.db.prepare('DELETE FROM webhooks WHERE control = $control');
    this.createWebhookToken = this.db.transaction(async (control: string): Promise<string> => {
      await this.deleteWebhookToken(control);
      const hook = Str.random(128);
      this.stmt_inswht.run({ control, hook });
      return hook;
    });
    
    const stmt_kvget = this.db.prepare('SELECT value FROM kvstore WHERE key = ?');
    const stmt_kvins = this.db.prepare('INSERT INTO kvstore VALUES (?, ?)');
    const stmt_kvdel = this.db.prepare('DELETE FROM kvstore WHERE key = ?');
    this.kvstore_get = (k: string): string | null => stmt_kvget.get(k)?.value || null;
    this.kvstore_set = this.db.transaction((k: string, v: string | null): void => {
      stmt_kvdel.run(k);
      if (v) {
        stmt_kvins.run(k, v);
      }
    });
  }

  async getControlRoomConfig(room: string): Promise<IControlConfig | null> {
    const config = this.stmt_getctrlconfig.get({ room }) || null;
    if (config) {
      config.moddata = JSON.parse(config.moddata as string);
    }
    return config;
  }
  // Set in constructor. It's a bit weird, I know
  setControlRoomConfig: (room: string, config: IControlConfig | null) => Promise<void>;

  getBridgedRoomConfig: (room: string) => Promise<IBridgedRoomConfigWithControl | null>;
  setBridgedRoomConfig: (room: string, config: IBridgedRoomConfig | null) => Promise<void>;
  async getBridgedRoomForNumber(control: string, number: string): Promise<string | null> {
    return this.stmt_getbrroom_num.get({ control, number })?.id || null;
  }

  createWebhookToken: (control: string) => Promise<string>;
  async getControlRoomFromWebhookToken(hook: string): Promise<string | null> {
    return this.stmt_getwht.get({ hook })?.control;
  }
  async deleteWebhookToken(control: string): Promise<void> {
    this.stmt_delwht.run({ control });
  }
  
  setSyncToken(token: string | null): void {
    this.kvstore_set('syncToken', token);
  }
  getSyncToken(): string | null {
    return this.kvstore_get('syncToken');
  }

  setFilter(filter: IFilterInfo): void {
    this.kvstore_set('filter', JSON.stringify(filter));
  }
  getFilter(): IFilterInfo {
    const json = this.kvstore_get('filter');
    return ((json && JSON.parse(json)) || null) as IFilterInfo;
  }

  addRegisteredUser(userId: string) {
    const key = sha512().update(userId).digest('hex');
    this.kvstore_set(`appserviceUsers.${key}.registered`, 'true');
  }
  isUserRegistered(userId: string): boolean {
    const key = sha512().update(userId).digest('hex');
    return this.kvstore_get(`appserviceUsers.${key}.registered`) === 'true';
  }

  isTransactionCompleted(id: string): boolean {
    return this.txns.has(id);
  }
  setTransactionCompleted(id: string) {
    this.txns.add(id);
  }

  readValue(key: string): string | null {
    return this.kvstore_get(`user_${key}`);
  }
  storeValue(key: string, value: string): void {
    this.kvstore_set(`user_${key}`, value)
  }
}

