//! `GET /skills` — metadata-only projection of the catalog.
//!
//! Body content (`DesktopSkill::body`) is intentionally NOT returned
//! over this endpoint to keep the payload small; the chat tool path
//! (`invoke_skill`) is the only consumer that needs the full markdown.
//! Same contract as the Node loader's /skills endpoint, so the
//! frontend SkillsPage / chat-state's skill picker keep working
//! after the Rust swap.

use std::sync::Arc;

use axum::{extract::State, Json};
use serde::Serialize;

use crate::server::AppState;
use crate::skills::{ScriptKind, SkillSource};

#[derive(Serialize)]
pub struct SkillsListResponse {
    pub skills: Vec<SkillSummary>,
    pub count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub full_description: String,
    pub category: String,
    pub source: SkillSource,
    pub requires_api_key: bool,
    pub requires_gpu: bool,
    pub allowed_tools: Vec<String>,
    pub scripts: Vec<ScriptSummary>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptSummary {
    pub relative_path: String,
    pub kind: ScriptKind,
}

pub async fn list_skills(State(state): State<Arc<AppState>>) -> Json<SkillsListResponse> {
    let skills: Vec<SkillSummary> = state
        .skills
        .skills
        .iter()
        .map(|s| SkillSummary {
            id: s.id.clone(),
            name: s.name.clone(),
            description: s.description.clone(),
            full_description: s.full_description.clone(),
            category: s.category.clone(),
            source: s.source.clone(),
            requires_api_key: s.requires_api_key,
            requires_gpu: s.requires_gpu,
            allowed_tools: s.allowed_tools.clone(),
            scripts: s
                .scripts
                .iter()
                .map(|sc| ScriptSummary {
                    relative_path: sc.relative_path.clone(),
                    kind: sc.kind,
                })
                .collect(),
        })
        .collect();
    let count = skills.len();
    Json(SkillsListResponse { skills, count })
}
