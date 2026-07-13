package com.anthropic.quotamgmt.auth;

import com.anthropic.quotamgmt.error.AppException;
import io.grpc.Status;
import org.junit.jupiter.api.Test;

import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Unit tests for RBAC grant logic and token authentication — no database. */
class AuthorizerTest {

    private final Authorizer authorizer = new InMemoryAuthorizer()
            .put("editor-tok", new Principal("alice@corp", Set.of("search-svc"), Set.of(), false))
            .put("viewer-tok", new Principal("bob@corp", Set.of(), Set.of("search-svc"), false))
            .put("admin-tok", new Principal("ops@corp", Set.of(), Set.of(), true));

    private static AppException expect(Status.Code code, Runnable r) {
        AppException e = assertThrows(AppException.class, r::run);
        assertEquals(code, e.code());
        return e;
    }

    @Test
    void unknownTokenIsUnauthenticated() {
        expect(Status.Code.UNAUTHENTICATED, () -> authorizer.authenticate("nope"));
        expect(Status.Code.UNAUTHENTICATED, () -> authorizer.authenticate(""));
        expect(Status.Code.UNAUTHENTICATED, () -> authorizer.authenticate(null));
    }

    @Test
    void editorMayEditOwnServiceOnly() {
        Principal alice = authorizer.authenticate("editor-tok");
        assertDoesNotThrow(() -> authorizer.requireEditor(alice, "search-svc"));
        expect(Status.Code.PERMISSION_DENIED, () -> authorizer.requireEditor(alice, "chat-svc"));
    }

    @Test
    void editorImpliesViewer() {
        Principal alice = authorizer.authenticate("editor-tok");
        assertDoesNotThrow(() -> authorizer.requireViewer(alice, "search-svc"));
    }

    @Test
    void viewerMayNotEdit() {
        Principal bob = authorizer.authenticate("viewer-tok");
        assertDoesNotThrow(() -> authorizer.requireViewer(bob, "search-svc"));
        expect(Status.Code.PERMISSION_DENIED, () -> authorizer.requireEditor(bob, "search-svc"));
    }

    @Test
    void platformAdminMayDoEverything() {
        Principal ops = authorizer.authenticate("admin-tok");
        assertDoesNotThrow(() -> authorizer.requirePlatformAdmin(ops));
        assertDoesNotThrow(() -> authorizer.requireEditor(ops, "any-svc"));
        assertDoesNotThrow(() -> authorizer.requireViewer(ops, "any-svc"));
        assertTrue(ops.canEdit("any-svc"));
    }

    @Test
    void nonAdminMayNotActAsAdmin() {
        Principal alice = authorizer.authenticate("editor-tok");
        expect(Status.Code.PERMISSION_DENIED, () -> authorizer.requirePlatformAdmin(alice));
    }

    @Test
    void viewableServicesUnionsEditorAndViewer() {
        Principal p = new Principal("carol", Set.of("a"), Set.of("b"), false);
        assertEquals(Set.of("a", "b"), p.viewableServices());
        assertTrue(p.canView("a"));
        assertTrue(p.canView("b"));
        assertFalse(p.canView("c"));
    }
}
