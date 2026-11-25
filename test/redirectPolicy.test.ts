import { describe, it, expect } from "vitest";
import { redirectUriProblem, registrationProblem } from "../src/redirectPolicy";

// oxjob #2323: the MCP authorization spec says every redirect URI MUST be https or localhost.
describe("redirectUriProblem", () => {
  it("allows https, loopback http and private-use app schemes", () => {
    for (const uri of [
      "https://attacker.example/cb",
      "https://claude.ai/api/mcp/auth_callback",
      "https://chatgpt.com/connector_platform_oauth_redirect",
      "http://localhost:33418/callback",
      "http://127.0.0.1:8080/cb",
      "http://[::1]:9000/cb",
      "http://127.1/cb", // the URL parser normalizes this to 127.0.0.1, still loopback
      "cursor://anysphere.cursor-retrieval/oauth/callback",
      "vscode://vscode.github-authentication/did-authenticate",
    ]) expect(redirectUriProblem(uri), uri).toBeNull();
  });

  it("refuses plain http to any other host", () => {
    for (const uri of [
      "http://attacker.example/cb",
      "http://localhost.attacker.example/cb",
      "http://localhost@attacker.example/cb",
      "http://10.0.0.1/cb",
      "HTTP://ATTACKER.EXAMPLE/cb",
      "http:attacker.example/cb",
      "http://localhost./cb",
    ]) expect(redirectUriProblem(uri), uri).toMatch(/https|user name/);
  });

  it("refuses other network and browser-internal schemes", () => {
    for (const uri of ["ftp://attacker.example/cb", "ws://attacker.example/cb", "wss://attacker.example/cb", "javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "blob:https://a.example/x", "about:blank"]) {
      expect(redirectUriProblem(uri), uri).toMatch(/https/);
    }
  });

  it("refuses whitespace and control characters the URL parser would silently drop", () => {
    for (const uri of ["java\tscript:alert(1)", "http://local\thost.attacker.example/cb", " https://a.example/cb", "https://a.example/cb\n"]) {
      expect(redirectUriProblem(uri), JSON.stringify(uri)).toMatch(/control characters/);
    }
  });

  it("refuses fragments, user info and unparseable URIs", () => {
    expect(redirectUriProblem("https://a.example/cb#frag")).toMatch(/fragment/);
    expect(redirectUriProblem("https://user:pw@a.example/cb")).toMatch(/user name/);
    expect(redirectUriProblem("http://attacker.example@localhost/cb")).toMatch(/user name/);
    expect(redirectUriProblem("not a url")).toMatch(/control characters|valid URL/);
    expect(redirectUriProblem("nourl")).toMatch(/valid URL/);
  });
});

describe("registrationProblem", () => {
  it("allows a normal registration", () => {
    expect(registrationProblem({ client_name: "Claude Code", redirect_uris: ["http://localhost:5000/callback"] })).toBeNull();
  });

  it("refuses when any redirect URI is plain http to a remote host", () => {
    expect(registrationProblem({ redirect_uris: ["https://ok.example/cb", "http://attacker.example/cb"] })).toMatchObject({ code: "invalid_redirect_uri" });
  });

  it("refuses missing or empty redirect_uris", () => {
    expect(registrationProblem({})).toMatchObject({ code: "invalid_redirect_uri" });
    expect(registrationProblem({ redirect_uris: [] })).toMatchObject({ code: "invalid_redirect_uri" });
  });

  it("caps the number and length of redirect URIs and the client name length", () => {
    const uris = Array.from({ length: 11 }, (_, i) => `https://a.example/${i}`);
    expect(registrationProblem({ redirect_uris: uris })?.description).toMatch(/at most 10/);
    expect(registrationProblem({ redirect_uris: ["https://a.example/" + "x".repeat(600)] })?.description).toMatch(/512/);
    expect(registrationProblem({ redirect_uris: ["https://a.example/cb"], client_name: "x".repeat(121) })).toMatchObject({ code: "invalid_client_metadata" });
  });
});
