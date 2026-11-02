# Feishu / Lark as the front door (optional)

People who never run an agent can work entirely from Feishu (Lark): answer
decision cards, see their Inbox, reply, post in channels and follow tasks.
Nothing else depends on this; skip it if you do not use Feishu.

1. **Create the app.** In the Feishu open platform (open.feishu.cn; Lark:
   open.larksuite.com) create an *enterprise self-built app* and enable the
   **Bot** capability.
2. **Permissions (scopes):** `im:message` (send as the bot),
   `im:message.p2p_msg:readonly` (receive direct messages), and optionally
   `contact:user.email:readonly` and `contact:user.base:readonly` (match people
   by email). Publish a version so they apply.
3. **Security settings:** note the *Verification Token* and set an *Encrypt
   Key* (required: the hub refuses unencrypted callbacks).
4. **Event subscription:** request URL
   `https://<ACH_PUBLIC_URL>/api/ach/feishu/events`, event
   `im.message.receive_v1` (Receive messages v2.0).
5. **Callback configuration (card callbacks):** the same URL, callback
   `card.action.trigger`.
6. **Configure the hub** (environment, or Settings → People → Feishu, or
   `PUT /api/ach/admin/feishu`):

   ```sh
   ACH_FEISHU_APP_ID=cli_xxx ACH_FEISHU_APP_SECRET=... \
   ACH_FEISHU_VERIFICATION_TOKEN=... ACH_FEISHU_ENCRYPT_KEY=... \
   ACH_FEISHU_REGION=feishu   # or lark
   ```

   Save the URLs from steps 4 and 5 after the hub runs with this config: Feishu
   verifies them right away.
7. **People.** A person whose Feishu directory email equals their AgentChannel
   email is matched on their first message to the bot. Otherwise map them in
   Settings → People → Feishu. "Send login link by Feishu" sends a one-time
   panel link to their direct messages. Unknown people are told to ask an
   admin for an invite.

What people can send the bot: `inbox`; `reply 2 <text>`; a reply in the thread
of any notification or card; `post #ops <text>`; `follow T-12` /
`unfollow T-12`. The same commands are understood in Chinese. Decision cards
show each option with its money impact, the recommended one first, and a link
to the panel; a tap is that person's own reply. Private-channel content never
leaves the hub (titles and links only). Details: [hub/API.md](../hub/API.md),
"Feishu adapter".
