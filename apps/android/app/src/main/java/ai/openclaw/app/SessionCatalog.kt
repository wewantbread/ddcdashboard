package ai.openclaw.app

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull

data class SessionCatalogState(
  val loading: Boolean = false,
  val catalogs: List<SessionCatalog> = emptyList(),
  val errorText: String? = null,
  val agentId: String? = null,
  val loadingMoreCatalogIds: Set<String> = emptySet(),
  val continuingEntryId: String? = null,
  val expandedHostIds: Set<String> = emptySet(),
)

data class SessionCatalog(
  val id: String,
  val label: String,
  val hosts: List<SessionCatalogHost>,
  val errorText: String? = null,
)

data class SessionCatalogHost(
  val catalogId: String,
  val hostId: String,
  val label: String,
  val kind: String,
  val connected: Boolean,
  val sessions: List<SessionCatalogEntry>,
  val nextCursor: String? = null,
  val errorText: String? = null,
)

data class SessionCatalogEntry(
  val catalogId: String,
  val hostId: String,
  val threadId: String,
  val sourceHomeId: String? = null,
  val agentId: String? = null,
  val name: String? = null,
  val cwd: String? = null,
  val status: String,
  val recencyAt: Double? = null,
  val source: String? = null,
  val modelProvider: String? = null,
  val gitBranch: String? = null,
  val customGroup: String? = null,
  val archived: Boolean,
  val sessionKey: String? = null,
  val canContinue: Boolean,
) {
  val locatorId: String
    get() = listOf(catalogId, hostId, threadId, sourceHomeId.orEmpty()).joinToString("\u0000")
}

internal fun sessionCatalogListParams(
  agentId: String?,
  progressId: String? = null,
): String =
  buildJsonObject {
    normalizedCatalogValue(agentId)?.let { put("agentId", JsonPrimitive(it)) }
    normalizedCatalogValue(progressId)?.let { put("progressId", JsonPrimitive(it)) }
    put("limitPerHost", JsonPrimitive(40))
  }.toString()

internal fun sessionCatalogPageParams(
  agentId: String?,
  catalogId: String,
  cursors: Map<String, String>,
): String =
  buildJsonObject {
    normalizedCatalogValue(agentId)?.let { put("agentId", JsonPrimitive(it)) }
    put("catalogId", JsonPrimitive(catalogId))
    put(
      "cursors",
      buildJsonObject {
        cursors.forEach { (hostId, cursor) ->
          put(hostId, JsonPrimitive(cursor))
        }
      },
    )
  }.toString()

internal fun sessionCatalogContinueParams(entry: SessionCatalogEntry): String =
  buildJsonObject {
    put("catalogId", JsonPrimitive(entry.catalogId))
    put("hostId", JsonPrimitive(entry.hostId))
    put("threadId", JsonPrimitive(entry.threadId))
    normalizedCatalogValue(entry.agentId)?.let { put("agentId", JsonPrimitive(it)) }
    normalizedCatalogValue(entry.sourceHomeId)?.let { put("sourceHomeId", JsonPrimitive(it)) }
  }.toString()

internal fun parseSessionCatalogContinueResult(
  raw: String,
  json: Json = Json { ignoreUnknownKeys = true },
): String {
  val root = json.parseToJsonElement(raw) as? JsonObject
  return root
    ?.string("sessionKey")
    ?.takeIf(String::isNotEmpty)
    ?: throw IllegalArgumentException("sessions.catalog.continue returned no sessionKey")
}

internal fun parseSessionCatalogs(
  raw: String,
  requestedAgentId: String?,
  json: Json = Json { ignoreUnknownKeys = true },
): List<SessionCatalog> {
  val root = json.parseToJsonElement(raw) as? JsonObject ?: return emptyList()
  val agentId = normalizedCatalogValue(requestedAgentId)
  return root.array("catalogs").mapNotNull { catalogElement ->
    val catalog = catalogElement as? JsonObject ?: return@mapNotNull null
    parseSessionCatalog(catalog, agentId)
  }
}

internal data class SessionCatalogHostProgress(
  val progressId: String,
  val agentId: String,
  val catalog: SessionCatalog,
)

internal fun parseSessionCatalogHostProgress(
  raw: String,
  json: Json = Json { ignoreUnknownKeys = true },
): SessionCatalogHostProgress? {
  val root = json.parseToJsonElement(raw) as? JsonObject ?: return null
  val progressId = root.string("progressId")?.takeIf(String::isNotEmpty) ?: return null
  val agentId = root.string("agentId")?.takeIf(String::isNotEmpty) ?: return null
  val catalogObject = root["catalog"] as? JsonObject ?: return null
  val catalog = parseSessionCatalog(catalogObject, agentId) ?: return null
  if (catalog.hosts.size != 1) return null
  return SessionCatalogHostProgress(progressId = progressId, agentId = agentId, catalog = catalog)
}

internal fun mergeSessionCatalogHostProgress(
  current: List<SessionCatalog>,
  progress: SessionCatalogHostProgress,
  preserveExpandedHostIds: Set<String> = emptySet(),
): List<SessionCatalog> {
  val incomingCatalog = progress.catalog
  val incomingHost = incomingCatalog.hosts.singleOrNull() ?: return current
  val currentCatalog = current.firstOrNull { it.id == incomingCatalog.id }
  if (currentCatalog == null) return (current + incomingCatalog).sortedBy(SessionCatalog::id)
  val currentHost = currentCatalog.hosts.firstOrNull { it.hostId == incomingHost.hostId }
  val hostKey = sessionCatalogHostKey(incomingCatalog.id, incomingHost.hostId)
  val mergedHost =
    if (currentHost != null && hostKey in preserveExpandedHostIds) {
      preserveExpandedSessionCatalogHost(fresh = incomingHost, previous = currentHost)
    } else {
      incomingHost
    }
  val hosts =
    if (currentHost == null) {
      currentCatalog.hosts + mergedHost
    } else {
      currentCatalog.hosts.map { host -> if (host.hostId == mergedHost.hostId) mergedHost else host }
    }
  val mergedCatalog = incomingCatalog.copy(hosts = hosts.sortedBy(SessionCatalogHost::label))
  return current.map { catalog -> if (catalog.id == mergedCatalog.id) mergedCatalog else catalog }
}

internal fun reconcileSessionCatalogRefresh(
  fresh: List<SessionCatalog>,
  previous: List<SessionCatalog>,
  preserveExpandedHostIds: Set<String>,
): List<SessionCatalog> {
  if (preserveExpandedHostIds.isEmpty()) return fresh
  val previousCatalogs = previous.associateBy(SessionCatalog::id)
  return fresh.map { catalog ->
    val previousHosts = previousCatalogs[catalog.id]?.hosts?.associateBy(SessionCatalogHost::hostId).orEmpty()
    catalog.copy(
      hosts =
        catalog.hosts.map { host ->
          val hostKey = sessionCatalogHostKey(catalog.id, host.hostId)
          val previousHost = previousHosts[host.hostId]
          if (previousHost != null && hostKey in preserveExpandedHostIds) {
            preserveExpandedSessionCatalogHost(fresh = host, previous = previousHost)
          } else {
            host
          }
        },
    )
  }
}

internal fun isLegacySessionCatalogProgressRejection(
  code: String,
  message: String,
): Boolean {
  if (!code.equals("INVALID_REQUEST", ignoreCase = true)) return false
  val normalized = message.lowercase()
  return "progressid" in normalized &&
    listOf("unexpected property", "unknown property", "unrecognized property", "additional property", "additional properties")
      .any(normalized::contains)
}

internal fun sessionCatalogHostKey(
  catalogId: String,
  hostId: String,
): String = "$catalogId\u0000$hostId"

internal fun mergeSessionCatalogPage(
  current: SessionCatalog,
  page: SessionCatalog,
): SessionCatalog {
  val pageByHost = page.hosts.associateBy(SessionCatalogHost::hostId)
  val mergedHosts =
    current.hosts.map { host ->
      pageByHost[host.hostId]?.let { mergeSessionCatalogHost(host, it) } ?: host
    } + page.hosts.filter { candidate -> current.hosts.none { it.hostId == candidate.hostId } }
  return current.copy(
    label = page.label,
    hosts = mergedHosts,
    errorText = page.errorText,
  )
}

private fun mergeSessionCatalogHost(
  current: SessionCatalogHost,
  page: SessionCatalogHost,
): SessionCatalogHost {
  val known = current.sessions.mapTo(mutableSetOf(), SessionCatalogEntry::locatorId)
  val appended = page.sessions.filter { known.add(it.locatorId) }
  return page.copy(sessions = current.sessions + appended)
}

private fun preserveExpandedSessionCatalogHost(
  fresh: SessionCatalogHost,
  previous: SessionCatalogHost,
): SessionCatalogHost {
  if (fresh.errorText != null) return previous.copy(errorText = fresh.errorText)
  val freshIds = fresh.sessions.mapTo(mutableSetOf(), SessionCatalogEntry::locatorId)
  return fresh.copy(
    sessions = fresh.sessions + previous.sessions.filter { it.locatorId !in freshIds },
    nextCursor = previous.nextCursor,
  )
}

private fun parseSessionCatalog(
  catalog: JsonObject,
  requestedAgentId: String?,
): SessionCatalog? {
  val catalogId = catalog.string("id")?.takeIf(String::isNotEmpty) ?: return null
  return SessionCatalog(
    id = catalogId,
    label = catalog.string("label")?.takeIf(String::isNotEmpty) ?: catalogId,
    hosts =
      catalog.array("hosts").mapNotNull { hostElement ->
        parseSessionCatalogHost(
          catalogId = catalogId,
          element = hostElement,
          requestedAgentId = requestedAgentId,
        )
      },
    errorText = catalog.errorMessage(),
  )
}

private fun parseSessionCatalogHost(
  catalogId: String,
  element: JsonElement,
  requestedAgentId: String?,
): SessionCatalogHost? {
  val host = element as? JsonObject ?: return null
  val hostId = host.string("hostId")?.takeIf(String::isNotEmpty) ?: return null
  return SessionCatalogHost(
    catalogId = catalogId,
    hostId = hostId,
    label = host.string("label")?.takeIf(String::isNotEmpty) ?: hostId,
    kind = host.string("kind") ?: "gateway",
    connected = host.boolean("connected") ?: false,
    sessions =
      host.array("sessions").mapNotNull { sessionElement ->
        parseSessionCatalogEntry(
          catalogId = catalogId,
          hostId = hostId,
          element = sessionElement,
          requestedAgentId = requestedAgentId,
        )
      },
    nextCursor = host.string("nextCursor"),
    errorText = host.errorMessage(),
  )
}

private fun parseSessionCatalogEntry(
  catalogId: String,
  hostId: String,
  element: JsonElement,
  requestedAgentId: String?,
): SessionCatalogEntry? {
  val session = element as? JsonObject ?: return null
  val threadId = session.string("threadId")?.takeIf(String::isNotEmpty) ?: return null
  return SessionCatalogEntry(
    catalogId = catalogId,
    hostId = hostId,
    threadId = threadId,
    sourceHomeId = session.string("sourceHomeId"),
    agentId = requestedAgentId,
    name = session.string("name"),
    cwd = session.string("cwd"),
    status = session.string("status")?.takeIf(String::isNotEmpty) ?: "unknown",
    recencyAt = session.number("recencyAt") ?: session.number("updatedAt") ?: session.number("createdAt"),
    source = session.string("source"),
    modelProvider = session.string("modelProvider"),
    gitBranch = session.string("gitBranch"),
    customGroup = session.string("customGroup"),
    archived = session.boolean("archived") ?: false,
    sessionKey = session.string("sessionKey")?.takeIf(String::isNotEmpty),
    canContinue = session.boolean("canContinue") ?: false,
  )
}

private fun normalizedCatalogValue(value: String?): String? = value?.trim()?.takeIf(String::isNotEmpty)

private fun JsonObject.errorMessage(): String? =
  (this["error"] as? JsonObject)
    ?.string("message")
    ?.takeIf(String::isNotEmpty)

private fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull?.trim()

private fun JsonObject.boolean(key: String): Boolean? = (this[key] as? JsonPrimitive)?.booleanOrNull

private fun JsonObject.number(key: String): Double? = (this[key] as? JsonPrimitive)?.doubleOrNull

private fun JsonObject.array(key: String): JsonArray = this[key] as? JsonArray ?: JsonArray(emptyList())
