package ai.openclaw.app.ui.chat

import ai.openclaw.app.GatewayModelSummary

internal data class ChatModelPickerSections(
  val pinned: List<GatewayModelSummary>,
  val recent: List<GatewayModelSummary>,
  val remaining: List<GatewayModelSummary>,
)

internal fun GatewayModelSummary.providerQualifiedRef(): String {
  val trimmedProvider = provider.trim()
  if (trimmedProvider.isEmpty()) return id
  val providerPrefix = "$trimmedProvider/"
  return if (id.startsWith(providerPrefix)) id else "$providerPrefix$id"
}

internal fun thinkingSupportedForSelection(
  selectedModelRef: String?,
  catalog: List<GatewayModelSummary>,
): Boolean {
  val selected = selectedModelRef ?: return true
  return catalog.firstOrNull { it.providerQualifiedRef() == selected }?.supportsReasoning != false
}

private val fastModeProviderIds =
  setOf("anthropic", "minimax", "minimax-portal", "openai", "xai")

private fun normalizeFastModeProvider(provider: String): String {
  val normalized = provider.trim().lowercase()
  return if (normalized == "codex" || normalized == "openai-codex") "openai" else normalized
}

private fun resolveFastModeProvider(
  selectedModelRef: String?,
  sessionModelProvider: String?,
  catalog: List<GatewayModelSummary>,
): String? {
  val selected = selectedModelRef?.trim()?.lowercase().orEmpty()
  val sessionProvider =
    sessionModelProvider
      ?.let(::normalizeFastModeProvider)
      ?.takeIf(String::isNotEmpty)
  return if (selected.isEmpty()) {
    sessionProvider
  } else {
    val idProviders = linkedSetOf<String>()
    val qualifiedProviders = linkedSetOf<String>()
    var hasCatalogMatch = false
    catalog.forEach { entry ->
      val matchesId = entry.id.trim().lowercase() == selected
      val matchesQualified = entry.providerQualifiedRef().trim().lowercase() == selected
      if (!matchesId && !matchesQualified) return@forEach
      hasCatalogMatch = true
      val entryProvider = normalizeFastModeProvider(entry.provider)
      if (entryProvider.isEmpty()) return@forEach
      if (matchesId) idProviders += entryProvider
      if (matchesQualified) qualifiedProviders += entryProvider
    }
    when {
      qualifiedProviders.size == 1 -> qualifiedProviders.first()
      sessionProvider != null &&
        sessionProvider in idProviders &&
        sessionProvider !in qualifiedProviders -> sessionProvider
      idProviders.size == 1 -> idProviders.first()
      hasCatalogMatch -> null
      '/' in selected -> normalizeFastModeProvider(selected.substringBefore('/'))
      else -> sessionProvider
    }
  }
}

internal fun fastModeProviderSupportedForSelection(
  selectedModelRef: String?,
  sessionModelProvider: String?,
  catalog: List<GatewayModelSummary>,
): Boolean =
  resolveFastModeProvider(
    selectedModelRef = selectedModelRef,
    sessionModelProvider = sessionModelProvider,
    catalog = catalog,
  ) in fastModeProviderIds

internal fun fastModeSupportedForSelection(
  providerSupported: Boolean,
  hasConfiguredFastModeOverride: Boolean,
): Boolean = providerSupported || hasConfiguredFastModeOverride

internal fun chatModelPickerSections(
  catalog: List<GatewayModelSummary>,
  favorites: List<String>,
  recents: List<String>,
): ChatModelPickerSections {
  val modelsByRef = catalog.associateBy { it.providerQualifiedRef() }
  val includedRefs = mutableSetOf<String>()
  val pinned =
    favorites.mapNotNull { ref ->
      modelsByRef[ref]?.takeIf { includedRefs.add(ref) }
    }
  val recent =
    recents.mapNotNull { ref ->
      modelsByRef[ref]?.takeIf { includedRefs.add(ref) }
    }
  val remaining = catalog.filter { model -> includedRefs.add(model.providerQualifiedRef()) }
  return ChatModelPickerSections(pinned = pinned, recent = recent, remaining = remaining)
}
