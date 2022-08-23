import { Buffer } from "https://deno.land/std@0.152.0/node/buffer.ts";

// // NaN is falsy, so will always
// let port: number;
// {
//   const envPort = Number(Deno.env.get("port"));
//   port = envPort;
//   if (isNaN(envPort)) {
//     port = 27015;
//   } else if (envPort < 1024 || envPort > 65535) {
//     port = 27015;
//   }
// }
// const ENV_PASSWORD = Deno.env.get("PASSWORD");
// if (!ENV_PASSWORD) throw new Error("Password is not set");

enum MessageType {
  SERVERDATA_RESPONSE_VALUE = 0,
  SERVERDATA_EXECCOMMAND = 2,
  SERVERDATA_AUTH_RESPONSE = 2,
  SERVERDATA_AUTH = 3,
}
type BaseMessage = {
  id: number | null;
  type: MessageType;
  body: string;
};
type Message = BaseMessage & {
  id: number;
  size: number;
};

class RCONServer {
  private listener: Deno.Listener;
  constructor(
    private host: string,
    private port: number,
    private password: string
  ) {
    this.listener = Deno.listen({ port: this.port, hostname: this.host });
    this.listen();
  }

  private generateId() {
    const id = new Uint32Array(1);
    crypto.getRandomValues(id);
    return id[0];
  }

  private writeMessage(message: BaseMessage): Buffer {
    const bodySize = Buffer.byteLength(message.body);
    const buffer = Buffer.alloc(bodySize + 14);

    buffer.writeInt32LE(bodySize + 10, 0); // body size + 2x null term + 2x int32
    buffer.writeInt32LE(message.id ?? this.generateId(), 4);
    buffer.writeInt32LE(message.type, 8);
    buffer.write(message.body, 12, bodySize + 10, "ascii");
    buffer.writeInt16BE(0, bodySize + 12); // finish with null term

    return buffer;
  }

  private readResponse(buffer: Buffer): Message {
    const size = buffer.readInt32LE(0);
    const id = buffer.readInt32LE(4);
    const type = buffer.readInt32LE(8);
    const body = buffer.toString("ascii", 12, size + 2);

    return {
      id,
      type,
      body,
      size,
    };
  }

  private async listen() {
    for await (const conn of this.listener) {
      this.handleConnection(conn);
    }
  }

  private async handleConnection(conn: Deno.Conn) {
    const authBuf = new Uint8Array(
      4 + 4 + 4 + Buffer.byteLength(this.password) + 2
    );
    await conn.read(authBuf);
    const authMessage = this.readResponse(Buffer.from(authBuf));

    if (authMessage.type !== MessageType.SERVERDATA_AUTH) {
      // invalid initial message type
      conn.close();
      return;
    }

    // send empty auth response value
    await conn.write(
      this.writeMessage({
        id: authMessage.id,
        type: MessageType.SERVERDATA_RESPONSE_VALUE,
        body: "",
      })
    );
    if (authMessage.body !== this.password) {
      // invalid password
      await conn.write(
        this.writeMessage({
          id: -1,
          type: MessageType.SERVERDATA_AUTH_RESPONSE,
          body: "",
        })
      );
      conn.close();
      return;
    } else {
      // valid password, send successful auth response
      await conn.write(
        this.writeMessage({
          id: authMessage.id,
          type: MessageType.SERVERDATA_AUTH_RESPONSE,
          body: "",
        })
      );
    }
  }
}
