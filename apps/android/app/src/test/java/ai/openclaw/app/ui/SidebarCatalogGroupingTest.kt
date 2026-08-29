package ai.openclaw.app.ui

import ai.openclaw.app.SessionCatalog
import ai.openclaw.app.SessionCatalogEntry
import ai.openclaw.app.SessionCatalogHost
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SidebarCatalogGroupingTest {
  @Test
  fun groupingKeepsHostsWorkspacesOtherWorkAndRecencyOrder() {
    val hosts =
      sidebarCatalogHosts(
        listOf(
          SessionCatalog(
            id = "codex",
            label = "Codex",
            hosts =
              listOf(
                SessionCatalogHost(
                  catalogId = "codex",
                  hostId = "desktop",
                  label = "Desktop",
                  kind = "node",
                  connected = true,
                  nextCursor = "next",
                  sessions =
                    listOf(
                      entry("older", cwd = "C:\\work\\openclaw", recency = 10.0),
                      entry("newer", cwd = "C:\\work\\openclaw", recency = 20.0),
                      entry("other", cwd = null, recency = 30.0),
                      entry("archived", cwd = "/work/hidden", recency = 40.0, archived = true),
                    ),
                ),
              ),
          ),
        ),
      )

    assertEquals(1, hosts.size)
    val host = hosts.single()
    assertEquals("Desktop", host.label)
    assertEquals("Codex", host.catalogLabel)
    assertTrue(host.connected)
    assertTrue(host.canLoadMore)
    assertEquals(listOf("openclaw", "Other work"), host.workspaces.map(SidebarCatalogWorkspace::label))
    assertEquals(
      listOf("newer", "older"),
      host.workspaces
        .first()
        .sessions
        .map(SessionCatalogEntry::threadId),
    )
    assertNull(host.workspaces.last().path)
    assertFalse(host.workspaces.any { workspace -> workspace.sessions.any(SessionCatalogEntry::archived) })
  }

  @Test
  fun fullyArchivedHostDoesNotLeaveAnEmptyHeading() {
    val hosts =
      sidebarCatalogHosts(
        listOf(
          SessionCatalog(
            id = "codex",
            label = "Codex",
            hosts =
              listOf(
                SessionCatalogHost(
                  catalogId = "codex",
                  hostId = "desktop",
                  label = "Desktop",
                  kind = "node",
                  connected = true,
                  sessions = listOf(entry("archived", cwd = "/work/hidden", recency = 1.0, archived = true)),
                ),
              ),
          ),
        ),
      )

    assertTrue(hosts.isEmpty())
  }

  private fun entry(
    threadId: String,
    cwd: String?,
    recency: Double,
    archived: Boolean = false,
  ): SessionCatalogEntry =
    SessionCatalogEntry(
      catalogId = "codex",
      hostId = "desktop",
      threadId = threadId,
      name = threadId,
      cwd = cwd,
      status = "idle",
      recencyAt = recency,
      archived = archived,
      canContinue = true,
    )
}
