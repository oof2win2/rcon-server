import { Buffer } from "https://deno.land/std@0.152.0/node/buffer.ts";
import { EventEmitter } from "https://deno.land/x/eventemitter@1.2.1/mod.ts";
import { iterateReader } from "https://deno.land/std@0.153.0/streams/conversion.ts";

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
  /**
   * Emitted when a c;lient disconnects from the server
   * @event RCONServer#disconnect
   * @param {number} clientId The ID of the client
   */
  close: (clientId: number) => void;
  /**
   * Emitted periodically to report any messages which have not been handled yet
   * @event RCONServer#unhandled
   * @param {number} clientId The ID of the client
   * @param {Message} message The message received from the client
   */
  unreplied: (clientId: number, message: Message) => void;
};

/**
 * A class for creating a RCON server
 */
class RCONServer extends EventEmitter<RCONServerListeners> {
  /**
   * TCP socket for the server
   */
  private listener: Deno.Listener;
  /**
   * Private map of IDs to connections
   */
  private connections: Map<number, Deno.Conn> = new Map();
  private unrepliedInterval: number;
  /**
   * Unreplied messages that can be checked through manually
   */
  unreplied: Map<number, Message[]> = new Map();

  constructor(
    private host: string,
    private port: number,
    private password: string
  ) {
    super();
    this.listener = Deno.listen({ port: this.port, hostname: this.host });
    this.listen();
    this.unrepliedInterval = setInterval(this.notifyUnreplied, 60 * 1000);
  }

  /**
   * Generates a random ID for a message
   * @returns {number} The next ID to use for a message
   */
  private generateId(): number {
    const id = new Uint32Array(1);
    crypto.getRandomValues(id);
    return id[0];
  }

  /**
   * Writes a message object to a buffer
   * @param message The message to send to the client
   * @returns {Buffer} The bytes to send to the client
   */
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

  /**
   * Reads a buffer and returns a message object
   * @param buffer The message that was received from the client
   * @returns {Message} The message object
   */
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

  /**
   * Handle a connection, from authentication to handling messages
   */
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
    this.unreplied.set(conn.rid, []);

    try {
      for await (const buffer of iterateReader(conn)) {
        const message = this.readResponse(Buffer.from(buffer));
        if (message.type === MessageType.SERVERDATA_EXECCOMMAND) {
          this.emit("request", conn.rid, message);
          this.unreplied.get(conn.rid)?.push(message);
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

  /**
   * Closes a connection
   * @param rid The ID of the connection to close
   */
  closeConnection(rid: number) {
    const conn = this.connections.get(rid);
    if (conn) {
      conn.close();
      this.connections.delete(rid);
      this.emit("close", rid);
      this.unreplied.delete(rid);
    }
  }

  /**
   * Reply to a request sent by a client
   * @param rid The ID of the connection to reply to
   * @param reqId The ID of the request to reply to
   * @param body The message body to send
   */
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
    // remove from unreplied
    const unreplied = this.unreplied.get(rid);
    if (unreplied) {
      const filtered = unreplied.filter((m) => m.id !== reqId);
      this.unreplied.set(rid, filtered);
    }
  }

  /**
   * Emit events about unreplied messages
   */
  notifyUnreplied() {
    for (const [rid, messages] of this.unreplied) {
      for (const message of messages) {
        this.emit("unreplied", rid, message);
      }
    }
  }

  /**
   * Destroy (close) the server
   */
  destroy() {
    this.listener.close();
    clearTimeout(this.unrepliedInterval);
  }
}

export default RCONServer;
