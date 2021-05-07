# matrix-pstn-bridge
A Matrix Puppet bridge for the public telephone network that supports a number
of VoIP providers (Twillo, Vonage, etc.)

It's not ready for production use yet, there are still a few things left to iron
out.

[Matrix Room](https://matrix.to/#/#matrix-pstn-bridge:kb1rd.net?via=kb1rd.net)

## Features
* Connect to [Twilio](https://www.twilio.com/) & get current account balance
* Multi-provider module system enables easy use of other providers than
Twilio (none yet implemented) and seamless switching between them.
* Send SMS texts to phone numbers and receive texts back
* Send and receive voice calls
* Intelligent dialing looks up phone numbers based on the one you're using
* Give SMS users "pet names"
* Allow multiple users to puppet a bridge & allow the bridging of bots
  * This bridge has a unique way of puppetting. Rather than being controlled by
  a single user, numbers are controlled in a single "control room." This allows
  multiple users to transparently puppet the same number. This is ideal for
  situations like in a small business where multiple people may want to talk or
  review conversation history.

## Planned Features
* [ ] Displaying bridge info in Element settings
* [ ] Dialer widget
* [ ] Sending MMS (pictures, video, voice, etc.)
* [ ] Getting extended information about users. Services like Twilio offer carrier
lookups and that sort of thing. Could be useful to help weed out spam.
* [x] Phone calls -- This is very hard
  * [ ] Answering machine
* [ ] Faxing. Why not, I guess?
* [ ] Pay-as-you-go managed phone number service
  * Start a chat with the bridge bot and buy a phone number via Matrix
  * Payment security is an issue here ;)
* [ ] Puppetting WhatsApp business or Facebook Messenger. Companies like Twilio
offer connections to proprietary messengers like these.

## Current Issues
* Only supports a SQLite DB
* Undefined behavior when invalid numbers are sent from the provider (ex,
Twilio) to the bridge
* Need a way to alert users of texts in rooms that they've left
* Membership syncing between control room and bridge rooms

## Setup

It's assumed that you have a Matrix server that supports Application Services,
which is currently only Synapse, installed and working. You also need a
publicly accessible IP address or domain name, ideally with a reverse proxy
such as NGINX with SSL support to ensure secure text delivery.

You'll also need an account with whichever provider you want to use.

If you need any help with this, please ask in the Matrix room. I'll try to
make this process easier where people get stuck.

First, the bridge code needs to be built. The following commands can be used:

```sh
$ yarn # Installs packages

$ yarn build # Builds the bridge
```

Now, edit the sample config to your liking. Once edited, you need to generate a
registration file:

```sh
$ node build/index.js -r # Run the bridge with the `-r` option, which generates a reg file
```

Now, put this file in your homeserver's config directory and edit the HS config
to add this registration. In the case of Synapse, this means adding the file to
the `app_service_config_files` variable in the config.

Finally, you can run the bridge with `node build/index.js`.

Once the bridge is up and running, you can start a chat with
`@_pstn_:myserver.org`, which will create a control room with a new puppet.
**Make sure E2EE is disabled when you make the room!**

Type `help` in this chat to see a list of available commands.

Type `link <module name>` to link the bridge. You'll receive instructions.

Once linked, you can use `dial <number...>` to start a DM. You cannot invite the
phone number directly to a room, so please use the `dial` command.

You can rename phone numbers with the `name` command and check you account
balance with the `status` command.
