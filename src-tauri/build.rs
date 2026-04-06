fn main() {
    // Debug: print where Cargo resolves paths from
    println!(
        "cargo:warning=CWD={}",
        std::env::current_dir().unwrap().display()
    );
    println!(
        "cargo:warning=CARGO_MANIFEST_DIR={}",
        std::env::var("CARGO_MANIFEST_DIR").unwrap()
    );
    let manifest_dir = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let python_dir = manifest_dir.join("python");
    println!(
        "cargo:warning=python dir exists: {} ({})",
        python_dir.exists(),
        python_dir.display()
    );
    if python_dir.exists() {
        for entry in std::fs::read_dir(&python_dir).unwrap() {
            let entry = entry.unwrap();
            println!("cargo:warning=  python/{}", entry.file_name().to_string_lossy());
        }
    }
    tauri_build::build()
}
