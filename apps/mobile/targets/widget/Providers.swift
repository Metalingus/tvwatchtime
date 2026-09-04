import Foundation
import UIKit
import WidgetKit

// MARK: - Entries

struct WatchNextRowModel: Identifiable {
  let item: WatchNextItem
  let image: UIImage?
  var id: String { item.id }
}

struct WatchNextEntry: TimelineEntry {
  let date: Date
  let rows: [WatchNextRowModel]
  let labels: WidgetLabels
  let signedOut: Bool
}

struct UpcomingRowModel: Identifiable {
  let item: UpcomingItem
  let image: UIImage?
  var id: String { item.id }
}

struct UpcomingSectionModel: Identifiable {
  let key: String
  let title: String
  let rows: [UpcomingRowModel]
  var id: String { key }
}

struct UpcomingEntry: TimelineEntry {
  let date: Date
  let sections: [UpcomingSectionModel]
  let labels: WidgetLabels
  let localeIdentifier: String
  let signedOut: Bool
}

// MARK: - Loading

private func refreshDate() -> Date {
  Calendar.current.date(byAdding: .minute, value: 30, to: Date()) ?? Date().addingTimeInterval(1800)
}

/// Download all images concurrently (a timeline build is time-budgeted, sequential
/// awaits blow it) and return them keyed by row id, preserving input order.
private func downloadImages<T: Identifiable>(
  for items: [T],
  url: (T) -> String?
) async -> [T.ID: UIImage]
where T.ID: Hashable & Sendable {
  await withTaskGroup(of: (T.ID, UIImage?).self) { group in
    for item in items {
      let id = item.id
      let imageURL = url(item)

      group.addTask {
        let image = await WidgetAPI.shared.loadImage(imageURL)
        return (id, image)
      }
    }

    var map: [T.ID: UIImage] = [:]

    for await (id, image) in group {
      if let image {
        map[id] = image
      }
    }

    return map
  }
}

struct WatchNextProvider: TimelineProvider {
  func placeholder(in context: Context) -> WatchNextEntry {
    WatchNextEntry(date: Date(), rows: [], labels: .fallback, signedOut: false)
  }

  func getSnapshot(in context: Context, completion: @escaping (WatchNextEntry) -> Void) {
    Task { completion(await load(maxRows: maxRows(for: context))) }
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<WatchNextEntry>) -> Void) {
    Task {
      let entry = await load(maxRows: maxRows(for: context))
      completion(Timeline(entries: [entry], policy: .after(refreshDate())))
    }
  }

  /// WidgetKit views do not scroll. Budget from the real device widget height and
  /// reserve both system content margins and this view's explicit 12pt padding.
  private func maxRows(for context: Context) -> Int {
    let contentHeight = max(90, context.displaySize.height - 56)
    return max(1, Int((contentHeight - 25) / 70))
  }

  private func load(maxRows: Int) async -> WatchNextEntry {
    let api = WidgetAPI.shared
    let labels = api.labels
    do {
      let data = try await api.fetch(path: "/me/watch-next", cacheKey: "cache.watchNext")
      let decoded = try JSONDecoder().decode(WatchNextResponse.self, from: data)
      var seen = Set<String>()
      let items = decoded.items.filter { item in
        guard item.bucket == "WATCH_NEXT", !seen.contains(item.episode.id) else { return false }
        seen.insert(item.episode.id)
        return true
      }.prefix(maxRows)
      api.pruneImageCache()
      let images = await downloadImages(for: Array(items)) { $0.episode.stillUrl ?? $0.backdropUrl }
      let rows = items.map { WatchNextRowModel(item: $0, image: images[$0.id]) }
      return WatchNextEntry(date: Date(), rows: rows, labels: labels, signedOut: false)
    } catch WidgetAPIError.notSignedIn {
      return WatchNextEntry(date: Date(), rows: [], labels: labels, signedOut: true)
    } catch {
      return WatchNextEntry(date: Date(), rows: [], labels: labels, signedOut: false)
    }
  }
}

struct UpcomingProvider: TimelineProvider {
  // Keep in sync with UPCOMING_NEAR_TERM_BUCKETS in packages/shared/src/enums.ts.
  private static let wantedKeys = ["TODAY", "TOMORROW", "THIS_WEEK"]

  func placeholder(in context: Context) -> UpcomingEntry {
    UpcomingEntry(
      date: Date(),
      sections: [],
      labels: .fallback,
      localeIdentifier: WidgetAPI.shared.localeIdentifier,
      signedOut: false
    )
  }

  func getSnapshot(in context: Context, completion: @escaping (UpcomingEntry) -> Void) {
    Task { completion(await load(maxHeight: contentHeight(for: context))) }
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<UpcomingEntry>) -> Void) {
    Task {
      let entry = await load(maxHeight: contentHeight(for: context))
      completion(Timeline(entries: [entry], policy: .after(refreshDate())))
    }
  }

  private func contentHeight(for context: Context) -> CGFloat {
    max(100, context.displaySize.height - 56)
  }

  private func load(maxHeight: CGFloat) async -> UpcomingEntry {
    let api = WidgetAPI.shared
    let labels = api.labels
    let localeIdentifier = api.localeIdentifier
    do {
      let data = try await api.fetch(path: "/me/upcoming", cacheKey: "cache.upcoming")
      let decoded = try JSONDecoder().decode(UpcomingResponse.self, from: data)
      let groups = decoded.groups.filter { Self.wantedKeys.contains($0.key) && !$0.items.isEmpty }
      // title (17pt) + final stack gap; each section header costs ~20pt including
      // spacing, and each 56pt-poster row costs 74pt including padding + spacing.
      var remainingHeight = maxHeight - 23
      var sections: [UpcomingSectionModel] = []
      api.pruneImageCache()
      for group in groups where remainingHeight >= 94 {
        remainingHeight -= 20
        let rowCount = max(0, Int(remainingHeight / 74))
        let items = Array(group.items.prefix(rowCount))
        if items.isEmpty { break }
        let images = await downloadImages(for: items) { $0.posterUrl }
        let rows = items.map { UpcomingRowModel(item: $0, image: images[$0.id]) }
        sections.append(UpcomingSectionModel(
          key: group.key,
          title: labels.groupTitle(for: group.key, fallback: group.label),
          rows: rows
        ))
        remainingHeight -= CGFloat(rows.count * 74)
      }
      return UpcomingEntry(
        date: Date(),
        sections: sections,
        labels: labels,
        localeIdentifier: localeIdentifier,
        signedOut: false
      )
    } catch WidgetAPIError.notSignedIn {
      return UpcomingEntry(
        date: Date(),
        sections: [],
        labels: labels,
        localeIdentifier: localeIdentifier,
        signedOut: true
      )
    } catch {
      return UpcomingEntry(
        date: Date(),
        sections: [],
        labels: labels,
        localeIdentifier: localeIdentifier,
        signedOut: false
      )
    }
  }
}
