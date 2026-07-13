# quotamgmt (control plane, Java 21 / gRPC).
# Build context is the REPOSITORY ROOT (the gradle build compiles the shared
# protos from ../proto), so build with:
#   docker build -f quotamgmt/Dockerfile -t quotamgmt .
FROM eclipse-temurin:21-jdk AS build
WORKDIR /src
# proto/ first (rarely changes) so the layer caches across app-only edits.
COPY proto/ proto/
COPY quotamgmt/ quotamgmt/
WORKDIR /src/quotamgmt
# installDist produces a self-contained launcher under build/install/quotamgmt.
RUN ./gradlew --no-daemon -x test installDist

FROM eclipse-temurin:21-jre AS runtime
WORKDIR /app
COPY --from=build /src/quotamgmt/build/install/quotamgmt/ /app/
# gRPC port (design default; overridable). The gradle launcher honors QUOTAMGMT_OPTS
# for JVM flags (e.g. -Dquotamgmt.auth.devAdminToken=...), set via the k8s secret.
ENV QUOTAMGMT_PORT=8443
EXPOSE 8443
ENTRYPOINT ["/app/bin/quotamgmt"]
