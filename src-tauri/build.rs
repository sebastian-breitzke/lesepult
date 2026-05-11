fn main() {
    #[cfg(target_os = "macos")]
    {
        cc::Build::new()
            .file("src/macos_export.m")
            .flag("-fobjc-arc")
            .compile("lesepult_macos_export");
        println!("cargo:rustc-link-lib=framework=WebKit");
        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rustc-link-lib=framework=PDFKit");
        println!("cargo:rerun-if-changed=src/macos_export.m");
    }
    tauri_build::build()
}
