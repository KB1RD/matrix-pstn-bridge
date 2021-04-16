import * as Express from 'express';
import {
  Appservice,
  IAppserviceOptions,
  MessageEvent,
  Intent,
  LogService,
} from 'matrix-bot-sdk';

import * as phone from './phonenumber';
import { getModule, listModules, IModule, IWebhookResponse } from './modules';
import { ICompleteConfig, getUserAction } from './config';
import { IBridgeDatabase, IBridgedRoomConfigWithControl } from './database';
import { BridgeHTTPServer } from './httpserver';

export interface IUserInfo {
  displayname: string
};

export interface IBridgeOptions extends IAppserviceOptions {
  prefix: string;
  storage: IBridgeDatabase;
  httpserver: BridgeHTTPServer;
  config: ICompleteConfig;
};

export class Bridge extends Appservice {
  // TODO: Make config option.
  protected readonly bot_name = 'PSTN Bridge Bot';

  constructor(protected readonly opts: IBridgeOptions) {
    // `options` is private in `Appservice`. We define it *again* as protected,
    // but called `opts`.
    super(opts);

    // Respond to user directory queries
    this.on('query.user', async (mxid, resp) => {
      if (this.botUserId === mxid) {
        // Set the bot's display name
        resp({ display_name: this.bot_name });
        return;
      }

      const suffix = this.getSuffixForUserId(mxid);
      if (!suffix) {
        return;
      }

      // Respond with a global number as the username
      await resp({ display_name: this.getSuffixDisplayName(suffix) });
    });

    // Respond to invites
    this.on('room.invite', async (room, { sender, state_key }) => {
      LogService.info('PstnBridge', `Got invite for ${state_key} to ${room}`);

      // Ignore invites for anything but the bot
      if (
        sender &&
        state_key === this.botUserId &&
        getUserAction(this.opts.config, sender) === 'FULL'
      ) {
        LogService.info('PstnBridge', `Accepting invite to ${room}`);
        try {
          await this.botIntent.joinRoom(room);
        } catch (e) {
          LogService.error('PstnBridge', `Failed to accept invite to ${room}: ${e}`);
        }
        return;
      }

      LogService.info('PstnBridge', `Rejecting invite to ${room}`);
      try {
        await this.getIntentForUserId(state_key).leaveRoom(room);
      } catch (e) {
        LogService.error('PstnBridge', `Failed to reject invite to ${room}: ${e}`);
      }
    });

    const self = this;
    this.addPreprocessor({
      getSupportedEventTypes(): string[] {
        return ['m.room.message'];
      },
      async processEvent(event: any): Promise<void> {
        const roomId = event?.room_id;
        if (typeof roomId !== 'string') {
          return;
        }

        const msg = new MessageEvent(event);
        if (
          msg.isRedacted ||
          !msg.sender ||
          typeof self.getBridgeUserId(msg.sender) === 'string'
        ) {
          return;
        }
        LogService.debug('PstnBridge', `Got message event in room ${roomId}`);

        if (getUserAction(self.opts.config, msg.sender) === 'DENY') {
          LogService.info('PstnBridge', `Denied message sending in ${roomId}`);
          self.botClient.sendNotice(roomId, 'Access denied');
          return;
        }

        const config = await self.db.getBridgedRoomConfig(roomId);

        // So not a bridged room
        if (!config) {
          if (msg.messageType === 'm.text') {
            LogService.debug('PstnBridge', `Processing event as control message`);
            await self.processControlMessage(msg.textBody, roomId, msg.sender);
          }
          return;
        }

        LogService.debug('PstnBridge', `Processing event as bridged message`);
        switch (msg.messageType) {
          case 'm.text':
            await self.processTextMessage(msg.textBody, roomId, config);
            break;
        }
      },
    });
    
    this.opts.httpserver.on('webhook', async ({ room, body }) => {
      // Each webhook is mapped to a control room. Get this config now
      const config = await this.db.getControlRoomConfig(room);
      if (!config) {
        LogService.warn('PstnBridge', `Got webhook hit for room ${room}, which is not configured`);
        return;
      }

      // Try looking up the module
      const mod = this.getModule(config.module);
      if (!mod) {
        LogService.warn('PstnBridge', `Got webhook hit for room ${room}, which is configured for unloaded module ${config.module}`);
        return;
      }

      let data: IWebhookResponse | null;
      try {
        // Try having the module process the webhook data
        data = await mod.processWebhook({ body });
      } catch (e) {
        LogService.error('PstnBridge', `Module ${config.module} failed to process webhook for room ${room}: ${e}`);
        return;
      }
      if (!data) {
        LogService.warn('PstnBridge', `Got webhook hit for room ${room}, which returned no data.`);
        return;
      }

      // Now, we can forward to the room
      LogService.debug('PstnBridge', `Sending text from ${data.from} to room ${room}`);
      try {
        const info = await self.getPhoneNumRoom(room, data.from);
        info.intent.sendText(info.room, data.text);
      } catch (e) {
        LogService.error('PstnBridge', `Failed to send text from ${data.from} to room ${room}: ${e}`);
      }
    });
  }

  /**
   * Lists modules that are enabled in the config.
   */
  listModules(): string[] {
    if (this.opts.config.permissions.modules.length) {
      return listModules()
        .filter((m) => this.opts.config.permissions.modules.includes(m));
    }
    return listModules();
  }
  /**
   * Gets a module. Returns `null` if it doesn't exist or is disabled in config.
   */
  getModule(n: string): IModule | null {
    const mods = this.opts.config.permissions.modules;
    if (mods.length && !mods.includes(n)) {
      return null;
    }
    return getModule(n);
  }

  protected get db() {
    return this.opts.storage;
  }

  /**
   * Gets the suffix for a telephone number.
   */
  getTelSuffix(number: string): string {
    return `tel-${number.slice(1)}`;
  }
  
  async begin(): Promise<void> {
    await super.begin();
    await this.botIntent.ensureRegistered();
    await this.botClient.setDisplayName(this.bot_name);
  }

  /**
   * Returns a display name for a particular suffix, or `null` if none defined.
   * @param suffix - Suffix to name
   * @param ctrl - Used for per-room names. This is the ID of the control room
   * controlling that particular bridge room.
   * @returns A name or `null`.
   */
  async getSuffixDisplayName(suffix: string, ctrl?: string): Promise<string | null> {
    const cfg = (typeof ctrl === 'string' && await this.db.getControlRoomConfig(ctrl)) || null;
    if (suffix.startsWith('tel-')) {
      const num = phone.getPhoneNumberFromE164('+' + suffix.slice(4));
      return num && num.formatForRegion(
        cfg?.number &&
        phone.getPhoneNumberFromE164(cfg.number)?._region
      );
    }
    return null;
  }

  /**
   * Array of command handler functions.
   */
  protected readonly commands = {
    async help(
      { replies }: { room: string, sender: string, replies: string[] },
    ): Promise<void> {
      replies.push(`Available commands:`);
      replies.push(`help - Print this message`);
      replies.push(`status - Print bridge status`);
      replies.push(`link <module> [args...] - Link to a phone number using <module>`);
      replies.push(`unlink - Remove the phone number link`);
      replies.push(`dial <number...> - Start chatting with a phone number`);
      replies.push(`name <number> [name...] - Set or clear a name for a number. The number can't have spaces.`);
      replies.push(`\nAvailable modules: ${this.listModules().join(', ')}`);
    },
    async status(
      { room, replies }: { room: string, sender: string, replies: string[] },
    ): Promise<void> {
      const config = await this.db.getControlRoomConfig(room);
      if (config) {
        const mod = this.getModule(config.module);
        if (!mod) {
          replies.push(`Linked to ${config.number} via a module that has been removed. You should re-link this bridge.`);
        } else {
          let stat = `${mod.friendly_name} failed to update status. Is the bridge still authenticated properly?`;
          try {
            stat = await mod.getStatusMsg(config.moddata);
          } catch (e) {
            LogService.warn('PstnBridge', `Failed to update status on ${room} for ${config.module}`);
          }
          replies.push(`Linked to ${config.number} via ${mod.friendly_name}. ${stat}`);
        }
      } else {
        replies.push(`Bridge not configured. Type 'link' to get started.`);
      }
    },

    async link(
      { room, replies }: { room: string, sender: string, replies: string[] },
      modname?: string,
      ...modargs: string[]
    ): Promise<void> {
      const mod = modname && this.getModule(modname);
      if (!mod) {
        replies.push('Usage: link <module name> [module args...]');
        replies.push('Try invoking a module to see its usage.');
        replies.push(`Valid modules are: ${this.listModules().join(', ')}`);
        return;
      }

      const opts = { webhook: await this.opts.httpserver.createWebhook(room) };

      try {
        const [number, moddata] = await mod.tryLink(opts, ...modargs);
        this.db.setControlRoomConfig(room, { module: modname, number, moddata });
        LogService.debug('PstnBridge', `Linked ${room} to ${number} via ${modname}`);
      } catch (e) {
        LogService.warn('PstnBridge', `Failed to link module ${modname}: ${e}`);
        replies.push(`Error linking to ${modname}: ${e.message}`);
        return;
      }

      replies.push(`Linked to module ${modname}.`);
    },
    async unlink(
      { room, replies }: { room: string, sender: string, replies: string[] },
    ): Promise<void> {
      this.db.setControlRoomConfig(room, null);
      this.db.deleteWebhookToken(room);
      replies.push(`Account unlinked`);
      LogService.debug('PstnBridge', `Unlinked ${room}`);
    },

    async dial(
      { room, sender, replies }: { room: string, sender: string, replies: string[] },
      ...numa: string[]
    ): Promise<void> {
      const config = await this.db.getControlRoomConfig(room);
      const num = phone.parsePhoneNumber(numa.join(' '), config?.number);
      if (!num) {
        replies.push(`Unrecognized phone number ${numa.join(' ')}`);
        return;
      }
      
      const info = await this.getPhoneNumRoom(room, num.E164, sender);
      if (!info.changed) {
        replies.push(`Bridge already open under ${info.room}.`);
      }
    },

    async name(
      { room, replies }: { room: string, sender: string, replies: string[] },
      nums?: string,
      ...namea: string[]
    ): Promise<void> {
      if (!nums) {
        replies.push(`Usage: name <number> [name...]`);
        return;
      }

      const config = await this.db.getControlRoomConfig(room);
      const num = phone.parsePhoneNumber(nums, config?.number);
      if (!num) {
        replies.push(`Unrecognized phone number ${nums}`);
        return;
      }

      const name = namea.join(' ').trim();
      
      const pn_room = await this.db.getBridgedRoomForNumber(room, num.E164);
      if (!pn_room) {
        replies.push('Room does not exist. Try dialing this number first');
        return;
      }
      
      this.setPhoneNumRoomDisplayName(
        room,
        pn_room,
        this.getTelSuffix(num.E164),
        name,
      );
      LogService.debug('PstnBridge', `Updating name in ${room} for ${num}`);
    },
  };
  async processControlMessage(text: string, room: string, sender: string): Promise<void> {
    let replies: string[] = [];
    const args = text.trim().split(' ').map((a) => a.trim()).filter((a) => a);

    LogService.debug('PstnBridge', `Got command ${args[0]} in ${room}`);
    
    let func = this.commands[args[0]];
    if (!func) {
      replies.push(`Unrecognized command: ${args[0]}`);
      func = this.commands.help;
    }
    try {
      await func.call(this, { room, sender, replies }, ...args.slice(1));
    } catch (e) {
      replies.push(`Internal error processing command`);
      LogService.error('PstnBridge', `Got error when processing ${args[0]} in ${room}: ${e}`);
    }

    if (replies.length) {
      this.botClient.sendNotice(room, replies.join('\n'));
    }
  }

  async processTextMessage(
    text: string,
    room: string,
    { remote_number, control_config }: IBridgedRoomConfigWithControl
  ): Promise<void> {
    const intent = this.getIntentForSuffix(this.getTelSuffix(remote_number));
    if (!(await intent.getJoinedRooms()).includes(room)) {
      this.db.setBridgedRoomConfig(room, null);
      return;
    }

    if (!control_config) {
      LogService.debug('PstnBridge', `Got bridge message in unlinked room ${room}.`);
      intent.sendText(
        room,
        'This bridge is not linked. Please use the link command in the bridge control room',
        'm.notice'
      );
      return;
    }

    const mod = this.getModule(control_config.module);
    if (!mod) {
      LogService.debug('PstnBridge', `Got bridge message in room ${room} with unregistered module ${control_config.module}`);
      intent.sendText(
        room,
        `The '${control_config.module}' module was removed since this bridge was linked. Cannot send`,
        'm.notice'
      );
      return;
    }

    try {
      LogService.debug('PstnBridge', `Sending message to ${remote_number} from ${room}`);
      mod.sendMessage(
        control_config.moddata,
        control_config.number,
        remote_number,
        text
      );
    } catch(e) {
      LogService.error('PstnBridge', `Failed to send message to ${remote_number} from ${room}: ${e}`);
      intent.sendText(
        room,
        `Failed to send message: ${e.message}`,
        'm.notice'
      );
    }
  }

  /**
   * Updates the `m.room.member` event in a bridged room to contain localized
   * display information. Is idempotent. This function trusts that the correct
   * values for the control room, bridged room, and user suffix are provided.
   * @param control - Control room for the bridged room
   * @param room - The bridged room
   * @param suffix - The suffix of the bridged user in `room`
   * @param dname - The desired name. If `undefined` or `null`, it is assumed
   * that the default name should be used unless the user has already specified
   * a pet name via the `name` command. If it is `''`, it is assumed that the
   * user wants to reset the name to the default. If it's a string, then the
   * name is set to exactly that string.
   * @returns A promise that resolves when complete.
   */
  async setPhoneNumRoomDisplayName(
    control: string,
    room: string,
    suffix: string,
    dname?: string | null,
  ): Promise<void> {
    const intent = this.getIntentForSuffix(suffix);
    const client = intent.underlyingClient;

    const [cstate, name] = await Promise.all([
      client.getRoomStateEvent(
        room,
        'm.room.member',
        this.getUserIdForSuffix(suffix)
      ),
      dname ? Promise.resolve(dname) : this.getSuffixDisplayName(suffix, control),
    ]);

    if (
      typeof dname != 'string' &&
      cstate &&
      cstate['net.kb1rd.bridge.userdef_display']
    ) {
      return;
    }
    if (!name) {
      return;
    }

    if (cstate?.membership === 'join' && cstate?.displayname !== name) {
      LogService.debug('PstnBridge', `Updating display name in room ${room} for ${suffix}.`);
      await client.sendStateEvent(
        room,
        'm.room.member',
        this.getUserIdForSuffix(suffix),
        Object.assign(
          {},
          cstate,
          {
            displayname: name,
            'net.kb1rd.bridge.userdef_display': Boolean(dname),
          },
        ),
      );
    }
  }

  /**
   * Gets or creates a room to talk to a particular phone number, possibly
   * inviting users.
   * @param control - The control room ID
   * @param e164 - The E164 number for the remote number
   * @param user - An optional user to ensure is in the room
   * @returns An object: `{ room: string, changed: boolean, intent: Intent }`
   * `room` contains the ID of the new/old room, `changed` is set to true if
   * some change to server state has been made (create or invite), and `intent`
   * is the bot SDK's intent for the phone number.
   */
  async getPhoneNumRoom(
    control: string,
    e164: string,
    user?: string,
  ): Promise<{ room: string, changed: boolean, intent: Intent }> {
    const suffix = this.getTelSuffix(e164);
    const intent = this.getIntentForSuffix(suffix);
    const client = intent.underlyingClient;

    // Username is managed on a per-room basis. Setting it gobally overwrites
    // the custom, per-room values
    // await intent.ensureRegistered();
    // const generic_name = await this.getSuffixDisplayName(suffix);
    // generic_name && await client.setDisplayName(generic_name);

    let room = await this.db.getBridgedRoomForNumber(control, e164);

    const reconcileRoomState = async () => {
      this.setPhoneNumRoomDisplayName(control, room as string, suffix);
    };

    if (typeof room === 'string' && (await intent.getJoinedRooms()).includes(room)) {
      await reconcileRoomState();
      if (user && !(await client.getJoinedRoomMembers(room)).includes(user)) {
        LogService.debug('PstnBridge', `Invited user ${user} to ${room}.`);
        await intent.underlyingClient.inviteUser(user, room);
        return { room, changed: true, intent };
      }
      LogService.debug('PstnBridge', `Room ${room} already exists. Taking no action.`);
      return { room, changed: false, intent };
    }

    // TODO: Sync membership
    const membership = (await this.botClient.getRoomMembers(control, undefined, ['join']))
      .map(({ membershipFor }) => membershipFor)
      .filter((m) => typeof this.getBridgeUserId(m) !== 'string');

    await intent.ensureRegistered();
    LogService.debug('PstnBridge', `Creating new room for ${control} to bridge to ${e164}.`);
    room = await client.createRoom({
      preset: 'private_chat',
      visibility: 'private',
      invite: membership,
      is_direct: true,
    });

    await this.db.setBridgedRoomConfig(
      room,
      { control_room: control, remote_number: e164 }
    );

    await reconcileRoomState();
    return { room, changed: true, intent };
  }
  
  getBridgeUserId(mxid: string): string | null {
    if (!mxid.startsWith('@')) {
      return null; // It's not even a MXID
    }
    const [localpart, ...rem] = mxid.slice(1).split(':');
    if (rem.join(':') !== this.opts.homeserverName) {
      return null; // Different server
    }

    // Check if its for this bridge
    if (localpart.startsWith(this.opts.prefix)) {
      // Get the part after the bridge prefix
      return localpart.slice(this.opts.prefix.length);
    }
    return null;
  }
}
