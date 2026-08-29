package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayEndpoint
import android.content.Context
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SessionCatalogRuntimeTest {
  @Test
  fun completedRefreshRetiresProgressOwner() {
    val app = RuntimeEnvironment.getApplication()
    val securePrefs =
      app.getSharedPreferences(
        "openclaw.node.session.catalog.test.${UUID.randomUUID()}",
        Context.MODE_PRIVATE,
      )
    val runtime = NodeRuntime(app, SecurePrefs(app, securePrefsOverride = securePrefs))
    try {
      ReflectionHelpers.setField(runtime, "connectedEndpoint", GatewayEndpoint.manual("127.0.0.1", 18789))
      ReflectionHelpers.setField(runtime, "operatorConnected", true)
      ReflectionHelpers.getField<MutableStateFlow<Boolean>>(runtime, "_sessionCatalogAvailable").value = true
      val requestParams = CompletableDeferred<String>()
      runtime.gatewayDataRequestOverrideForTests = { _, method, params ->
        check(method == "sessions.catalog.list")
        requestParams.complete(requireNotNull(params))
        """{"catalogs":[]}"""
      }

      runtime.refreshSessionCatalog("main")

      runBlocking {
        val params = withTimeout(2_000) { requestParams.await() }
        val progressId =
          Json
            .parseToJsonElement(params)
            .jsonObject["progressId"]
            ?.jsonPrimitive
            ?.content
        assertTrue(!progressId.isNullOrBlank())
        withTimeout(2_000) {
          while (runtime.sessionCatalogState.value.loading) delay(10)
        }
      }
      val owner =
        ReflectionHelpers.getField<AtomicReference<Any?>>(runtime, "sessionCatalogProgressOwner")
      assertNull(owner.get())
    } finally {
      closeNodeRuntimeTestFixture(runtime)
    }
  }
}
