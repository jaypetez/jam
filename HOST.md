# Hosting jam rooms on your own Claude

You were given a **host code** for a hosted jam hub (for example jam.nullagency.io). The hub only relays messages.
Every Claude turn in your rooms runs on **your** machine, on **your** Claude account.

## Set up (about two minutes, macOS recommended)

You need Node 22+ and Claude Code installed and signed in (`claude` once in a terminal).

```bash
mkdir -p ~/jam && cd ~/jam
curl -fsSL https://jam.nullagency.io/dl/jam.tgz | tar xz --strip-components 1
node claim.mjs <host-code> <host-name>     # host-name: 3–20 lowercase letters/digits
./run.sh                                   # your bridge — keep it running
```

`claim.mjs` makes your owner key on this machine and prints your lobby link. The hub never sees the key, only a hash.
Create rooms from the lobby (each room is one Claude Code session in one folder on this machine), then mint invite
links from inside a room.

## Who pays for what

- **Your own messages** run on your Claude Code login (subscription or API key, whatever `claude` uses).
- **Guests who drive** (send messages) need your **Anthropic API key**, because a Claude subscription can't be
  shared. Add it to `.env` in this folder, then restart `./run.sh`:
  `JAM_DRIVER_API_KEY=sk-ant-...`
  Without it, guests' messages are refused with a clear note. **Viewers** can always watch.
- Per-driver budgets are in each invite's menu in the room sidebar.

## Safety

- On macOS every guest's shell command runs inside a Seatbelt sandbox that limits it to the room's folder. Risky
  actions still pause for your Allow/Deny card. On Linux/Windows there's no sandbox, so the card is the only gate:
  invite drivers you trust.
- Your owner key (`.jam-key`, and the lobby link with `?k=`) is full control of your rooms. Don't share it.
- Up to 20 rooms per host. The hub owner can disable a host.

## Updating

Re-run the `curl … | tar xz --strip-components 1` line in the same folder. It doesn't touch `.jam-key` or `.env`.
A bridge started by `./run.sh` restarts itself on the new code when its rooms are idle.
