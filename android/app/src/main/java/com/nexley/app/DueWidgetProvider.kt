package com.nexley.app

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Nexley — home-screen widget showing what's due.
 *
 * WHERE THE DATA COMES FROM: the SAME SharedPreferences file the
 * @capacitor/preferences plugin writes to from JS (app/widget.js). This
 * class never talks to the WebView, IndexedDB, or Supabase directly — it
 * only reads a small JSON blob another part of the app already put here.
 * "CapacitorStorage" is that plugin's own default group name (verified
 * against its Android source, PreferencesConfiguration.java, 2026-09-07 —
 * re-check that file if this ever silently stops updating after a plugin
 * upgrade, since a renamed default would break this without either side
 * throwing an error).
 *
 * UNVERIFIED — READ BEFORE RELYING ON THIS. Written without a device or
 * emulator to test on. The Kotlin compiles against the standard
 * AppWidgetProvider API and nothing here is exotic, but "compiles" and
 * "renders correctly on an actual home screen" are different claims. Build
 * the debug APK (android-debug-build.yml already does this on every push),
 * side-load it, and actually add the widget before trusting it.
 */
class DueWidgetProvider : AppWidgetProvider() {

    override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
        for (id in appWidgetIds) {
            updateOne(context, appWidgetManager, id)
        }
    }

    private fun updateOne(context: Context, manager: AppWidgetManager, widgetId: Int) {
        val views = RemoteViews(context.packageName, R.layout.widget_due)

        val prefs = context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE)
        val raw = prefs.getString("nexley_widget_data", null)

        if (raw == null) {
            // Never opened the app on this device yet, or the bridge hasn't
            // written anything — an honest empty state, not an error.
            views.setTextViewText(R.id.widget_headline, "Open Nexley")
            views.setTextViewText(R.id.widget_detail, "to see what's due")
        } else {
            try {
                val data = JSONObject(raw)
                val dueThisWeek = data.optInt("dueThisWeek", 0)
                val nextTitle = data.optString("nextTitle", null)
                val nextDue = data.optLong("nextDue", 0L)

                views.setTextViewText(
                    R.id.widget_headline,
                    when (dueThisWeek) {
                        0 -> "Nothing due this week"
                        1 -> "1 thing due this week"
                        else -> "$dueThisWeek things due this week"
                    }
                )

                if (nextTitle != null && nextDue > 0L) {
                    val fmt = SimpleDateFormat("EEE d MMM", Locale.getDefault())
                    views.setTextViewText(R.id.widget_detail, "Next: $nextTitle · ${fmt.format(Date(nextDue))}")
                } else {
                    views.setTextViewText(R.id.widget_detail, "")
                }
            } catch (e: Exception) {
                // A malformed blob is a bug on the JS side, not a reason to
                // crash a home screen — same "fail honestly, fail quietly"
                // call the rest of this app makes for anything widget-shaped.
                views.setTextViewText(R.id.widget_headline, "Nexley")
                views.setTextViewText(R.id.widget_detail, "Open the app to refresh")
            }
        }

        // Tapping the widget opens the app, same as tapping its home-screen
        // icon would — a widget with no launch action is a dead end.
        val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)
        if (launchIntent != null) {
            val pendingIntent = PendingIntent.getActivity(
                context, 0, launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            views.setOnClickPendingIntent(R.id.widget_root, pendingIntent)
        }

        manager.updateAppWidget(widgetId, views)
    }
}
