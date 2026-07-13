package com.anthropic.quotamgmt.paging;

import com.anthropic.quotamgmt.error.AppException;

import java.nio.charset.StandardCharsets;
import java.util.Base64;

/**
 * Opaque keyset pagination cursor (design/quotamgmt.md §3.5). Encodes the last
 * key of a page so the next query resumes with a {@code WHERE key > :cursor}
 * predicate — stable and offset-free. The wire form is base64url; callers treat
 * it as opaque. A malformed token yields {@code INVALID_ARGUMENT}.
 */
public final class PageToken {

    private static final Base64.Encoder ENCODER = Base64.getUrlEncoder().withoutPadding();
    private static final Base64.Decoder DECODER = Base64.getUrlDecoder();

    private PageToken() {
    }

    /** Encode a numeric keyset cursor (e.g. {@code limit_config.id}). */
    public static String encodeLong(long cursor) {
        return encode(Long.toString(cursor));
    }

    /** Encode a text keyset cursor (e.g. {@code service.service_name}). */
    public static String encode(String cursor) {
        return ENCODER.encodeToString(cursor.getBytes(StandardCharsets.UTF_8));
    }

    /**
     * Decode a numeric cursor. Empty/blank token means "start from the
     * beginning" and returns {@code defaultValue}.
     */
    public static long decodeLong(String token, long defaultValue) {
        if (token == null || token.isEmpty()) {
            return defaultValue;
        }
        try {
            return Long.parseLong(decode(token));
        } catch (NumberFormatException e) {
            throw AppException.invalidArgument("page_token", "malformed page_token");
        }
    }

    /** Decode a text cursor; empty/blank token returns {@code null} (from the start). */
    public static String decode(String token) {
        if (token == null || token.isEmpty()) {
            return null;
        }
        try {
            return new String(DECODER.decode(token), StandardCharsets.UTF_8);
        } catch (IllegalArgumentException e) {
            throw AppException.invalidArgument("page_token", "malformed page_token");
        }
    }
}
