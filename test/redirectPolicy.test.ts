import { describe, it, expect } from "vitest";
import { redirectUriProblem, registrationProblem } from "../src/redirectPolicy";

// oxjob #2323: the MCP authorization spec says every redirect URI MUST be https or localhost.
describe("redirectUriProblem", () => {
  it("allows https, loopback http and private-use schemes", () => {
    for (const uri of [
      "https://attacker.example/cb",
      "https://claude.ai/api/mcp/auth_callback",
      "https://chatgpt.com/connector_platform_oauth_redirect",
      "http://localhost:33418/callback",
      "http://127.0.0.1:8080/cb",
      "http://[::1]:9000/cb",
      "cursor://anysphere.cursor-retrieval/oauth/callback",
    ]) expect(redirectUriProblem(uri), uri).toBeNull();
  });

  it("refuses plain http to any other host", () => {
    for (const uri of ["http://attacker.example/cb", "http://localhost.attacker.example/cb", "http://10.0.0.1/cb", "HTTP://ATTACKER.EXAMPLE/cb"]) {
      expect(redirectUriProblem(uri), uri).toMatch(/https/);
    }
  });

  it("refuses an over-long or unparseable URI", () => {
    expect(redirectUriProblem("https://a.example/" + "x".repeat(600))).toMatch(/512/);
    expect(redirectUriProblem("not a url")).toMatch(/valid URL/);
  });
});

describe("registrationProblem", () => {
  it("allows a normal registration", () => {
    expect(registrationProblem({ client_name: "Claude Code", redirect_uris: ["http://localhost:5000/callback"] })).toBeNull();
  });

  it("refuses when any redirect URI is plain http to a remote host", () => {
    expect(registrationProblem({ redirect_uris: ["https://ok.example/cb", "http://attacker.example/cb"] })).toMatch(/https/);
  });

  it("caps the number of redirect URIs and the client name length", () => {
    const uris = Array.from({ length: 11 }, (_, i) => `https://a.example/${i}`);
    expect(registrationProblem({ redirect_uris: uris })).toMatch(/at most 10/);
    expect(registrationProblem({ redirect_uris: ["https://a.example/cb"], client_name: "x".repeat(121) })).toMatch(/120/);
  });
});
