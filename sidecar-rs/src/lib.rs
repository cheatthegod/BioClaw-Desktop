//! BioClaw sidecar crate root. Re-exports the modules that the
//! `bioclaw-sidecar` binary uses, so `cargo test` can reach them via
//! the library target. The binary entry point lives in `main.rs`.

pub mod auth;
pub mod chat;
pub mod cli;
pub mod env;
pub mod logging;
pub mod mcp;
pub mod memory;
pub mod permissions;
pub mod saas;
pub mod server;
pub mod skills;
pub mod workspace;
