# quotamgmt — control plane

Java 21 / Gradle gRPC service implementing `quotamgmt.v1.LimitAdmin` (see
[`../proto/quotamgmt/v1/limit_admin.proto`](../proto/quotamgmt/v1/limit_admin.proto)).
This is **scaffolding**: the server starts and registers the service, but every
RPC returns `UNIMPLEMENTED`.

## Build & run

The Gradle wrapper is **not** committed. Generate it once with a locally
installed Gradle (8.x):

```sh
gradle wrapper
```

Then:

```sh
./gradlew build      # compiles protos from ../proto and the Java sources
./gradlew run        # starts the gRPC server
```

Or run the built jar:

```sh
./gradlew installDist
./build/install/quotamgmt/bin/quotamgmt
```

## Configuration

- **Port** — plaintext gRPC, default `8443`. Override with the JVM system
  property `-Dquotamgmt.port=<port>` (e.g. `./gradlew run -Dquotamgmt.port=9000`).

TLS/mTLS is out of scope for the scaffold (design/quotamgmt.md §7.1).

## Not yet implemented

The business logic — Postgres config + audit store, audited writes
(`SET LOCAL app.actor`), validation, authN/Z and tenant scoping, and the config
change-feed to the data plane — is specified in
[`../design/quotamgmt.md`](../design/quotamgmt.md) (§3–§10) and is TODO.
