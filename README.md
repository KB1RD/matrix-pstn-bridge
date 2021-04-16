# matrix-pstn-bridge
A Matrix Puppet bridge for the public telephone network that supports a number
of VoIP providers (Twillo, Vonage, etc.)

It's not ready for production use yet, there are still a few things left to iron
out.

[Matrix Room](https://matrix.to/#/#matrix-pstn-bridge:kb1rd.net?via=kb1rd.net)

## Features
* Connect to [Twilio](https://www.twilio.com/) & get current account balance
* Send SMS texts to phone numbers and receive texts back
* Intelligent dialing looks up phone numbers based on the one you're using
* Give SMS users "pet names"
* Allow multiple users to puppet a bridge & allow the bridging of bots
  * This bridge has a unique way of puppetting. Rather than being controlled by
  a single user, numbers are controlled in a single "control room." This allows
  multiple users to transparently puppet the same number. This is ideal for
  situations like in a small business where multiple people may want to talk or
  review conversation history.

## Planned Features
* Sending MMS (pictures, video, voice, etc.)
* Getting extended information about users. Services like Twilio offer carrier
lookups and that sort of thing. Could be useful to help weed out spam.
* Phone calls -- This is very hard
  * Answering machine
* Faxing. Why not, I guess?
* Pay-as-you-go managed phone number service
  * Start a chat with the bridge bot and buy a phone number via Matrix
  * Payment security is an issue here ;)
* Puppetting WhatsApp business or Facebook Messenger. Companies like Twilio
offer connections to proprietary messengers like these.

## Current Issues
* Only supports a SQLite DB
* Undefined behavior when invalid numbers are sent from the provider (ex,
Twilio) to the bridge
* Need a way to alert users of texts in rooms that they've left

## Setup

First, the bridge code needs to be built.


