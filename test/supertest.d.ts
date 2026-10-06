declare module "supertest" {
  import type { Express } from "express";
  export interface Test extends PromiseLike<Response> {
    set(name: string, value: string): Test;
    send(body: unknown): Test;
    expect(status: number): Test;
    expect(body: unknown): Test;
    expect(status: number, body: unknown): Test;
    expect(field: string, value: string | RegExp): Test;
  }
  interface Agent {
    get(path: string): Test;
    post(path: string): Test;
  }
  export default function request(app: Express): Agent;
}
