fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Compile the shared gRPC contracts from ../proto. The include path is the
    // proto root so `import "quota/common/v1/common.proto"` resolves.
    tonic_build::configure().build_client(false).compile_protos(
        &[
            "../proto/quotaenforcer/v1/rate_limiter.proto",
            "../proto/quota/common/v1/common.proto",
        ],
        &["../proto"],
    )?;
    Ok(())
}
