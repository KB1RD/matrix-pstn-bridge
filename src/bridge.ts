import {
  Appservice,
  IAppserviceOptions,
  MessageEvent,
  Intent,
  LogService,
  RoomEvent,
  MessageEventContent,
} from 'matrix-bot-sdk';
import * as Str from '@supercharge/strings';

import * as phone from './phonenumber';
import { getModule, listModules, IModule } from './modules';
import { ICompleteConfig, getUserAction } from './config';
import { IBridgeDatabase, IBridgedRoomConfigWithControl } from './database';
import { BridgeHTTPServer } from './httpserver';
import { PhoneCall } from './modules/module';
import { CallState } from './call';
import * as voip_ev from './signalling_events';

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

  // Room name <-> call
  protected readonly active_calls = new Map<string, PhoneCall>();

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
        return ['m.room.message', 'm.call.answer', 'm.call.invite', 'm.call.candidates', 'm.call.hangup'];
      },
      async processEvent(e_raw: any): Promise<void> {
        const roomId = e_raw?.room_id;
        if (typeof roomId !== 'string') {
          return;
        }

        const event = new RoomEvent<object>(e_raw);
        if (
          !event.sender ||
          !event.type ||
          typeof self.getBridgeUserId(event.sender) === 'string'
        ) {
          return;
        }
        LogService.debug(
          'PstnBridge',
          `Got event of type '${event.type}' in room ${roomId}`,
        );

        if (getUserAction(self.opts.config, event.sender) === 'DENY') {
          LogService.info('PstnBridge', `Denied message sending in ${roomId}`);
          self.botClient.sendNotice(roomId, 'Access denied');
          return;
        }

        const config = await self.db.getBridgedRoomConfig(roomId);

        // So not a bridged room
        if (!config) {
          let msg: MessageEvent<MessageEventContent>
          if (
            event.type === 'm.room.message' &&
            (msg = new MessageEvent(e_raw)).messageType === 'm.text'
          ) {
            LogService.debug('PstnBridge', `Processing event as control message`);
            await self.processControlMessage(msg.textBody, roomId, msg.sender);
          }
          return;
        }

        LogService.debug('PstnBridge', `Processing event as bridged message`);
        await self.processBridgedEvent(event, roomId, config);
      },
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

  protected get db(): IBridgeDatabase {
    return this.opts.storage;
  }

  /**
   * Gets the suffix for a telephone number.
   */
  getTelSuffix(number: string): string {
    return `tel-${number.slice(1)}`;
  }
  
  async begin(): Promise<void> {
    const self = this;
    const handlers = {
      async getConfig(control: string): Promise<object | null> {
        return (await self.db.getControlRoomConfig(control))?.moddata || null;
      },
      async createCall(
        control: string,
        from: string,
      ): Promise<PhoneCall | null> {
        try {
          const [info, cfg] = await Promise.all([
            self.getPhoneNumRoom(control, from),
            self.db.getControlRoomConfig(control),
          ]);
          if (!info || !cfg) {
            throw new Error('No registered number in room');
          }

          const call = new PhoneCall(cfg.number, from, Str.random(64));
          self.addNewCall(info.room, call);
          return call;
        } catch (e) {
          LogService.info(
            `PstnBridge`,
            `Failed to create phone call from ${from} to user under control room ${control}.`
          );
          return null;
        }
      },
      async sendText(
        control: string,
        from: string,
        body: string,
      ): Promise<void> {
        try {
          const info = await self.getPhoneNumRoom(control, from);
          info.intent.sendText(info.room, body);
        } catch (e) {
          LogService.info(
            `PstnBridge`,
            `Failed to send text from ${from} to user under control room ${control}.`
          );
        }
      },
    };

    const modules = this.listModules();
    for (const modname of modules) {
      const mod = this.getModule(modname);
      (mod as IModule).registerWebhooks(
        this.opts.httpserver.getModuleApp(modname),
        handlers,
      );
    }

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

  addNewCall(room: string, call: PhoneCall): boolean {
    // TODO glare
    this.active_calls.set(room, call);
    call.on('ended', () => {
      if (this.active_calls.get(room) === call) {
        LogService.info(
          `PstnBridge CALL/${room}/${call.matrix_id}`,
          `Call was hung up or failed. Call will be deleted.`
        );
        this.active_calls.delete(room);
      }
    });

    const sendEvent = async (type: string, event: object): Promise<void> => {
      const intent = this.getIntentForSuffix(this.getTelSuffix(call.remote));
      intent.underlyingClient.sendEvent(room, type, event);
    }
    call.on('send_invite', async (sdp: string) => {
      try {
        await sendEvent('m.call.invite', {
          call_id: call.matrix_id,
          // TODO: What should this be?
          lifetime: 60000,
          offer: { sdp, type: 'offer' },
          version: 0,
        });
      } catch (e) {
        LogService.error(
          `PstnBridge CALL/${room}/${call.matrix_id}`,
          `Error sending invite: ${e}`
        );
      }
    });
    call.on('send_candidates', async (candidates_sdp: string[]) => {
      try {
        await sendEvent('m.call.candidates', {
          call_id: call.matrix_id,
          candidates: candidates_sdp.map((candidate) => ({
            candidate,
            // TODO: Verify this stuff
            sdpMLineIndex: 0,
            sdpMid: 'audio',
          })),
          version: 0,
        });
      } catch (e) {
        LogService.error(
          `PstnBridge CALL/${room}/${call.matrix_id}`,
          `Error sending candidates: ${e}`
        );
      }
    });
    call.on('send_accept', async (sdp: string) => {
      try {
        await sendEvent('m.call.answer', {
          call_id: call.matrix_id,
          // TODO: What should this be?
          lifetime: 60000,
          answer: { sdp, type: 'answer' },
          version: 0,
        });
      } catch (e) {
        LogService.error(
          `PstnBridge CALL/${room}/${call.matrix_id}`,
          `Error sending answer: ${e}`
        );
      }
    });
    call.on('send_hangup', async () => {
      try {
        await sendEvent('m.call.hangup', {
          call_id: call.matrix_id,
          version: 0,
        });
      } catch (e) {
        LogService.error(
          `PstnBridge CALL/${room}/${call.matrix_id}`,
          `Error sending hangup: ${e}`
        );
      }
    });
    return true;
  }

  /**
   * Array of command handler functions.
   */
  protected readonly commands = {
    async help(
      this: Bridge,
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
      this: Bridge,
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
      this: Bridge,
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

      const opts = {
        webhook: await this.opts.httpserver.createWebhook(
          modname as string,
          room,
        ),
      };

      try {
        const [number, moddata] = await mod.tryLink(opts, ...modargs);
        this.db.setControlRoomConfig(
          room,
          { module: modname as string, number, moddata }
        );
        LogService.debug('PstnBridge', `Linked ${room} to ${number} via ${modname}`);
      } catch (e) {
        LogService.warn('PstnBridge', `Failed to link module ${modname}: ${e}`);
        replies.push(`Error linking to ${modname}: ${e.message}`);
        return;
      }

      replies.push(`Linked to module ${modname}.`);
    },
    async unlink(
      this: Bridge,
      { room, replies }: { room: string, sender: string, replies: string[] },
    ): Promise<void> {
      this.db.setControlRoomConfig(room, null);
      this.db.deleteWebhookToken(room);
      replies.push(`Account unlinked`);
      LogService.debug('PstnBridge', `Unlinked ${room}`);
    },

    async dial(
      this: Bridge,
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
      this: Bridge,
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

  async processBridgedEvent(
    event: RoomEvent<object>,
    room: string,
    { remote_number, control_config}: IBridgedRoomConfigWithControl
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
      if (event.type === 'm.room.message') {
        const msg = new MessageEvent(event.raw);
        switch (msg.messageType) {
          case 'm.text':
            LogService.debug('PstnBridge', `Sending message to ${remote_number} from ${room}`);
            await mod.sendMessage(
              control_config.moddata,
              control_config.number,
              remote_number,
              msg.textBody,
            );
            break;
        }
      } else if (event.type === 'm.call.invite') {
        LogService.debug('PstnBridge', `Creating call to ${remote_number} in ${room}`);
        const content = event.content as unknown;
        if (!voip_ev.IVoipInvite.validate(content)) {
          LogService.warn('PstnBridge', `Failed to process call invite in ${room}: Invalid event`);
          return;
        }

        if (content.version !== 0 && content.version !== 1) {
          LogService.warn('PstnBridge', `Invite in ${room} has unsupported version ${content.version}`);
          return;
        }

        const call = new PhoneCall(
          control_config.number,
          remote_number,
          content.call_id
        );
        call.matrix_call_version = content.version;
        call.state = CallState.INVITED;
        this.addNewCall(room, call);
        await mod.sendCallInvite(
          control_config.moddata,
          call,
          content.offer.sdp,
        );
      } else if (event.type === 'm.call.candidates') {
        const call = this.active_calls.get(room);
        if (!call) {
          LogService.warn('PstnBridge', `Failed to process call candidates in ${room}: No known active call in room. Was the bridge restarted with active calls?`);
          return;
        }

        const content = event.content as unknown;
        if (!voip_ev.IVoipCandidates.validate(content)) {
          LogService.warn('PstnBridge', `Failed to process call candidates in ${room}: Invalid event`);
          return;
        }

        if (content.version !== 0 && content.version !== 1) {
          LogService.warn('PstnBridge', `Candidates event in ${room} has unsupported version ${content.version}`);
          return;
        }
        if (content.call_id !== call.matrix_id) {
          LogService.debug('PstnBridge', `Ignoring candidates event for other call ${content.call_id} in room ${room}`);
          return;
        }

        await mod.sendCallCandidates(
          control_config.moddata,
          call,
          content.candidates.map(({ candidate }) => candidate),
        );
      } else if (event.type === 'm.call.answer') {
        const call = this.active_calls.get(room);
        if (!call) {
          LogService.warn('PstnBridge', `Failed to process call answer in ${room}: No known active call in room. Was the bridge restarted with active calls?`);
          return;
        }

        const content = event.content as unknown;
        if (!voip_ev.IVoipAnswer.validate(content)) {
          LogService.warn('PstnBridge', `Failed to process call answer in ${room}: Invalid event`);
          return;
        }

        if (content.version !== 0 && content.version !== 1) {
          LogService.warn('PstnBridge', `Answer in ${room} has unsupported version ${content.version}`);
          return;
        }
        if (content.call_id !== call.matrix_id) {
          LogService.debug('PstnBridge', `Ignoring answer for other call ${content.call_id} in room ${room}`);
          return;
        }

        call.state = CallState.ACCEPTED;
        await mod.sendCallAccept(
          control_config.moddata,
          call,
          content.answer.sdp,
        );
      } else if (event.type === 'm.call.hangup') {
        const call = this.active_calls.get(room);
        if (!call) {
          LogService.warn('PstnBridge', `Failed to process call hangup in ${room}: No known active call in room. Was the bridge restarted with active calls?`);
          return;
        }

        const content = event.content as unknown;
        if (!voip_ev.IVoipHangup.validate(content)) {
          LogService.warn('PstnBridge', `Failed to process call answer in ${room}: Invalid event`);
          return;
        }

        if (content.version !== 0 && content.version !== 1) {
          LogService.warn('PstnBridge', `Hangup in ${room} has unsupported version ${content.version}`);
          return;
        }
        if (content.call_id !== call.matrix_id) {
          LogService.debug('PstnBridge', `Ignoring hangup for other call ${content.call_id} in room ${room}`);
          return;
        }
        // TODO: Is it even necessary to have a function in the module? Since
        // changing the state fires an event, which the module can listen for
        call.state = CallState.HUNGUP;
        await mod.sendCallHangup(control_config.moddata, call);
      } else {
        LogService.debug('PstnBridge', `Couldn't process event to ${remote_number} from ${room}. Unknown type ${event.type}`);
      }
    } catch(e) {
      LogService.error('PstnBridge', `Failed to send event of type ${event.type} to ${remote_number} from ${room}: ${e}`);
      intent.sendText(
        room,
        `Failed to forward event: ${e.message}`,
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
