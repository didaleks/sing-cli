"use strict";
// COPIED FROM singularity-mcp-server (upstream MCP-пакет, MIT) — utils/auth.js @ 2026-06-19 — не редактировать вручную.
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAuthHeader = createAuthHeader;
/**
 * Creates authorization header with provided token
 * @param token - JWT token
 * @returns Headers object with Authorization header
 */
function createAuthHeader(token) {
    return {
        Authorization: `Bearer ${token}`,
    };
}
//# sourceMappingURL=auth.js.map