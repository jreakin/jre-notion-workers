import { describe, expect, test } from "bun:test";
import { getZohoAccountsBaseUrl } from "./zoho-client.js";
describe("getZohoAccountsBaseUrl", () => {
    test("maps US API domain to US accounts domain", () => {
        expect(getZohoAccountsBaseUrl("https://www.zohoapis.com")).toBe("https://accounts.zoho.com");
    });
    test("maps EU API domain to EU accounts domain", () => {
        expect(getZohoAccountsBaseUrl("https://www.zohoapis.eu")).toBe("https://accounts.zoho.eu");
    });
    test("maps AU API domain to AU accounts domain", () => {
        expect(getZohoAccountsBaseUrl("https://www.zohoapis.com.au")).toBe("https://accounts.zoho.com.au");
    });
    test("falls back to US accounts domain for invalid input", () => {
        expect(getZohoAccountsBaseUrl("not-a-url")).toBe("https://accounts.zoho.com");
    });
});
