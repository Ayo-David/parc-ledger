declare module "supertest" {
  import type { Express } from "express";
  export interface Test extends PromiseLike<Response> {
    set(name: string, value: string): Test;
    send(body: unknown): Test;
    expect(status: number): Test;
    expect(body: unknown): Test;
  }
  interface Agent {
    post(path: string): Test;
  }
  export default function request(app: Express): Agent;
}
