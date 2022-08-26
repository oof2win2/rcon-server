import { Buffer } from "https://deno.land/std@0.152.0/node/buffer.ts";
import { EventEmitter } from "https://deno.land/x/eventemitter@1.2.1/mod.ts";
import { iterateReader } from "https://deno.land/std@0.153.0/streams/conversion.ts";

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

type RCONServerListeners = {
  /**
   * Emitted when the server is listening for connections.
   * @event RCONServer#connection
   * @param {number} clientId The ID of the client
   */
  connection: (clientId: number) => void;
  /**
   * Emitted when the server receives a request from a client
   * @event RCONServer#request
   * @param {number} clientId The ID of the client
   * @param {Message} message The message received from the client
   */
  request: (clientId: number, message: Message) => void;
  close: (clientId: number) => void;
  unreplied: (clientId: number, message: Message) => void;
};

class RCONServer extends EventEmitter<RCONServerListeners> {
  private listener: Deno.Listener;
  private connections: Map<number, Deno.Conn> = new Map();
  // private _unreplied: Map<number, Message[]> = new Map();
  constructor(
    private host: string,
    private port: number,
    private password: string
  ) {
    super();
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
    this.emit("connection", conn.rid);
    this.connections.set(conn.rid, conn);

    try {
      for await (const buffer of iterateReader(conn)) {
        const message = this.readResponse(Buffer.from(buffer));
        if (message.type === MessageType.SERVERDATA_EXECCOMMAND) {
          this.emit("request", conn.rid, message);
        } else if (message.type === MessageType.SERVERDATA_RESPONSE_VALUE) {
          // response from client is an echo
          conn.write(buffer);
        }
      }
      this.closeConnection(conn.rid);
    } catch (e) {
      if (e instanceof Deno.errors.BadResource) {
        this.closeConnection(conn.rid);
      }
    }
  }

  closeConnection(rid: number) {
    const conn = this.connections.get(rid);
    if (conn) {
      conn.close();
      this.connections.delete(rid);
      this.emit("close", rid);
    }
  }

  async reply(rid: number, reqId: number, body: string) {
    const conn = this.connections.get(rid);
    if (!conn) {
      throw new Error("Connection not found");
    }
    const message = this.writeMessage({
      id: reqId,
      type: MessageType.SERVERDATA_RESPONSE_VALUE,
      body,
    });
    await conn.write(message);
  }
}

export default RCONServer;
