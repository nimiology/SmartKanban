# Telegram context retrieval constraints

Verified against Telegram's official documentation on 2026-09-23. Scope: the standard Telegram Bot API used by a group bot.

## Group visibility

Telegram enables group Privacy Mode for bots by default. In that mode, bots see commands addressed to them, relevant inline messages, replies intended for the bot, and service messages; they do not receive every ordinary group message. Making the bot an admin or disabling Privacy Mode lets it receive all group messages. When Privacy Mode is changed, Telegram says the bot must be removed and re-added for the change to take effect. [Bot Features: Privacy Mode](https://core.telegram.org/bots/features#privacy-mode)

Telegram added **Guest Mode** to Bot API 10.0 in May 2026. An eligible bot can be mentioned in a supported non-secret private chat, group, or supergroup without joining it. The `guest_message` update carries the invocation and any referenced messages, such as a message being replied to; the bot answers that invocation with `answerGuestQuery`. Guest Mode does not provide chat history or future messages, and protected-content groups are excluded. [Bot Features: Guest Bots](https://core.telegram.org/bots/features#guest-bots) · [Bot API: Guest Mode changelog and methods](https://core.telegram.org/bots/api#answerguestquery)

**Planning implication:** a plain natural-language reply to an arbitrary teammate message may not reach a joined bot under the default setting. For intentional, low-access capture, prefer Guest Mode: reply to the relevant message, mention `@botname`, and include a short instruction. This gives the bot the trigger and referenced message without opening the rest of the chat. If SmartKanban must observe ordinary conversation continuously or send ongoing notifications as a group member, the group must opt into the broader access of a joined bot; keep Privacy Mode on if commands and replies are sufficient.

## Replies and forum topics

An incoming `Message` can include `reply_to_message`, which contains the original message from the same chat and thread; Telegram limits this embedded reply object to one level and says it may be omitted for ephemeral messages. Messages in forum topics carry `message_thread_id` and `is_topic_message`. Bot API send methods accept `message_thread_id` to post into a selected topic. [Bot API: Message](https://core.telegram.org/bots/api#message) · [Bot API: sendMessage](https://core.telegram.org/bots/api#sendmessage)

**Planning implication:** store the source chat ID, message ID, `message_thread_id`, reply target, and prompt text with each captured task. The bot can acknowledge or post task updates in the originating topic. A user reply gives the bot the replied-to message directly; it does not grant access to the rest of that topic's history.

## Historical search

The Bot API documents receiving messages as updates and does not expose a method to search or enumerate arbitrary chat history. Telegram's separate MTProto `messages.search` method does support text search, but its official reference explicitly says **only users can use this method**. [Bot API: Getting updates](https://core.telegram.org/bots/api#getting-updates) · [MTProto: messages.search](https://core.telegram.org/method/messages.search)

**Planning implication:** a standard Bot API bot cannot search all past messages when a prompt arrives. It can use the replied-to message and any context the application already saved from updates it was allowed to receive. If more context is needed, implement a bounded search over that application-owned store, scoped to the triggering chat/topic and a small recent time/message window. For pre-existing history the bot never received, users would need to forward relevant messages or choose a separate user-account integration; this is not available through the standard bot API.

## Update retention and recovery

Telegram supports either `getUpdates` long polling or webhooks. Incoming updates remain on Telegram's servers until delivered, but are not retained for longer than 24 hours. [Bot API: Getting updates](https://core.telegram.org/bots/api#getting-updates)

**Planning implication:** persist each in-scope update in SmartKanban promptly and deduplicate by Telegram update/message ID. Do not treat Telegram's update queue as the task-context database: after an outage exceeding 24 hours, undelivered context may be unavailable from the Bot API.

## Recommended context flow

1. Preferred low-access path: a user replies to the relevant message, mentions the Guest Mode bot, and adds a short instruction. Otherwise, a joined bot can receive an explicit task command/reply under Privacy Mode.
2. Use the update's prompt, referenced/replied-to message, and topic identifiers as the initial context.
3. Search only SmartKanban's stored, bot-visible messages for that same chat/topic, with explicit age and result limits; do not crawl unrelated chats or topics.
4. Show the evidence used to draft the task and ask a targeted follow-up if owner, scope, or acceptance criteria remain unclear.

This keeps capture intentional and context retrieval bounded while respecting what the Bot API can actually deliver. Guest Mode only answers its invocation; confirm in a prototype whether its response presentation fits the group's chosen forum topic before relying on it for routine board notifications.
