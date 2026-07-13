use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Compile the shared gRPC contracts from ../proto. The include path is the
    // proto root so `import "quota/common/v1/common.proto"` resolves.
    //
    // We also emit the encoded FileDescriptorSet so the server can expose gRPC
    // server reflection (lets grpcurl et al. call methods without local .proto
    // files).
    let descriptor_path = PathBuf::from(std::env::var("OUT_DIR")?).join("quotaenforcer_descriptor.bin");
    tonic_build::configure()
        .build_client(false)
        .file_descriptor_set_path(&descriptor_path)
        .compile_protos(
            &[
                "../proto/quotaenforcer/v1/rate_limiter.proto",
                "../proto/quota/common/v1/common.proto",
            ],
            &["../proto"],
        )?;
    Ok(())
}
