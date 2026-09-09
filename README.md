# dialer

A small voice intercom that runs on your own network. Anyone who opens the page
is given a 4 digit number, you type someone else's number and you talk. The audio
goes directly between the two browsers, not via the server. The server is just
for serving the page and introducing the two browsers to each other.

Calls can be bigger than two. If you're already talking to someone and a third
calls you, you can let them in and everyone ends up in the same call.

## Running it

You need Node installed, then
```

npm install
node server.js
```

It should print something like
```

Dialer running
─────────────────────────────────────────
This machine:  http://localhost:8080
Other machines: http://192.168.1.42:8080
```

Open the first link on the machine the server is running on, and the second one on
your phone or a different laptop on the same wifi. If port 8080 is taken,
do PORT=3000 node server.js.

## Sounds

Put three mp3s in a folder called sounds next to server.js:
```

sounds/call.mp3
sounds/join.mp3
sounds/leave.mp3
```

call.mp3 loops while the phone is ringing, on both ends. join.mp3 plays
when someone picks up or joins. leave.mp3 plays when someone hangs up or drops
out. The server tells you at startup if it found all three, so if you got the
filenames wrong, you know. It's easy to get them mixed up.

## Using it

Your number is the big one at the top. The first time a browser opens the page
the server hands it a free number and remembers it in numbers.json next to
server.js, so it's yours from then on, whether you're online or not, and it
survives the server restarting. The browser saves it too, so don't clear the
site data. You can change it with the Change button; if you ask for a number
that belongs to someone else you just keep your old one. A number nobody has
used for a month frees up. Open the page in one tab only: a second tab in the
same browser is told the number is open elsewhere and waits until the first
one closes. If your wifi drops for a moment, the page reconnects by itself and
you keep your number and your call.

Type a number, call. They get a ring and Answer/Decline. Once you're talking, the
call box shows everyone who's in it and whether they're muted.

To add someone else to a call you're already in, the dial box becomes an
"Add someone" box. Type their number and they get rung. Same thing works the other
way round, someone can call you while you're mid call and you can pull them in.

Mute mutes you for everyone at once. Leave drops you out but the call keeps
going for the rest.

There's a log at the bottom. It's ugly on purpose, it tells you exactly what's
happening, which is very handy when something doesn't work.

## Two things that will trip you up

Browsers block sound until you interact with the page. The page checks for
this the moment it loads, and if sound is blocked, it shows an "Enable sound"
button. Click it once and the ringtone works. If you skip it, calls still work
fine, they're just silent, which is bad, you won't hear the ring.

The microphone needs a secure page. localhost counts as secure, so the
machine the server is running on is fine. Another computer on plain http is not,
and Chrome will refuse the mic. The log says so the moment the page loads, so
you know before you try to call. Easiest fix is to open
```

chrome://flags/#unsafely-treat-insecure-origin-as-secure
```

and add the address the server printed (the `http://192.168.x.x:8080` one). Restart
Chrome and it works. The startup message reminds you of this with the right
address filled in.

There's also an "Allow microphone" button on the page. Worth clicking before
your first call, otherwise the permission popup shows up right when you're
trying to answer and the other person is sitting there ringing.

## Calling over the internet

Put the page behind https (a Cloudflare tunnel to localhost:8080 does it). That
gets the ringing and the introductions through. The audio itself goes machine
to machine, and between two home routers it finds its own way. From a school
or mobile network it often can't, and the call fails with "Could not connect".
The fix is a relay, and one is built in and on by default: at startup the
server finds your public IP (one STUN question, the same kind every call asks)
and runs the relay on it. The only thing you do is on your router: forward UDP
port 3478 and UDP ports 49160 to 49200 to the machine running the server. The
startup message says what it found. The relay password is random every start
and handed to the page by itself. If your public IP changes, the server notices
within half an hour and carries on. To use a hostname instead, or to override
what it found,
```

TURN_HOST=your.public.hostname node server.js
```

A tunnel service that hands you a public UDP port instead of the port forward
looks like it should work here, and it doesn't. The relay has to see the real
address of whoever sends to it, and a tunnel passes the packets on as its own,
so the relay drops every one of them and the call is silent. It has to be the
router.

## Stuff it doesn't do

If the server can't learn its public IP at startup (no internet at that
moment), there is no relay and calls only work where the direct path does.
Restart it once the connection is back.

It's a mesh, meaning everyone sends their audio to everyone else separately.
Three or four people is fine. Six people on home wifi is going to sound rough.
Past that you'd need a proper media server and this isn't that.

No accounts, no passwords, nothing. Anyone who can reach the page can pick a
number and call anyone. If it's on the internet, put something in front of it
that limits who can open it.

Nothing is saved on the server. Restart it and everyone reconnects by themselves
within a few seconds, but the server has forgotten who was in a call with whom,
so leave and call again.

## The code

It's all one file. server.js has the server and the web page inside it as
strings, split into numbered sections with a map at the top. There are two
dependencies, `socket.io` for the signaling and `node-turn` for the relay, and
no build step. If you're going to change it, read
CLAUDE.md first, there's a list in there of bugs that have already been fixed
once and are easy to accidentally put back.
