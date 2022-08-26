# rcon-server

A Deno implementation for an RCON server.

## Usage

Below is a simple example of how to use the RCON server to send an echo.

```ts
import Server from "https://deno.land/x/rcon_server@v1.0.0/src/mod.ts";

const server = new Server("localhost", 27015, "password");

server.on("request", (client, message) => {
  console.log(message.body);
  if (message.body.startsWith("echo ")) {
    server.reply(client, message.id, message.body.substring(5));
  } else {
    server.reply(client, message.id, "This message is not supported yet");
  }
});
```

The server will emit `unreplied` events if a message has not been replied to. This is due to the fact that the RCON protocol
*requires* messages to be replied to, even if it is with `''` (`0x00`).