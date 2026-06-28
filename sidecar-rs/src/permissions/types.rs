//! Wire types + cache key for permission decisions.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionDecision {
    /// Persisted in the allow-always cache; future calls to the same
    /// `(skill_id, script)` pair skip the modal.
    Allow,
    /// One-shot allow — the current tool call proceeds, but the next
    /// matching call will prompt again.
    AllowOnce,
    /// Reject the current call. The tool returns an error result so
    /// the model can react ("user denied; trying a different path…").
    Deny,
}

/// Stable cache key built from `(skill_id, script_relative_path)`.
/// Matches the Node port's `permissionCacheKey()` exactly so a
/// /permissions/preload payload from the frontend (which mirrors
/// the renderer's persisted permission list) hits the same entries.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct PermissionKey {
    pub skill_id: String,
    pub script: String,
}

impl PermissionKey {
    pub fn new(skill_id: impl Into<String>, script: impl Into<String>) -> Self {
        Self {
            skill_id: skill_id.into(),
            script: script.into(),
        }
    }
}
