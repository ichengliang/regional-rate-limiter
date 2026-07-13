package com.anthropic.quotamgmt.paging;

import com.anthropic.quotamgmt.error.AppException;
import io.grpc.Status;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

/** Unit tests for the opaque keyset cursor. */
class PageTokenTest {

    @Test
    void longRoundTrips() {
        String token = PageToken.encodeLong(8121L);
        assertEquals(8121L, PageToken.decodeLong(token, 0L));
    }

    @Test
    void stringRoundTrips() {
        String token = PageToken.encode("search-svc");
        assertEquals("search-svc", PageToken.decode(token));
    }

    @Test
    void emptyLongTokenReturnsDefault() {
        assertEquals(0L, PageToken.decodeLong("", 0L));
        assertEquals(Long.MAX_VALUE, PageToken.decodeLong(null, Long.MAX_VALUE));
    }

    @Test
    void emptyStringTokenReturnsNull() {
        assertNull(PageToken.decode(""));
        assertNull(PageToken.decode(null));
    }

    @Test
    void malformedLongTokenRejected() {
        String notANumber = PageToken.encode("abc");
        AppException e = assertThrows(AppException.class, () -> PageToken.decodeLong(notANumber, 0L));
        assertEquals(Status.Code.INVALID_ARGUMENT, e.code());
        assertEquals("page_token", e.field());
    }

    @Test
    void malformedBase64Rejected() {
        AppException e = assertThrows(AppException.class, () -> PageToken.decode("!!!not-base64!!!"));
        assertEquals(Status.Code.INVALID_ARGUMENT, e.code());
    }
}
