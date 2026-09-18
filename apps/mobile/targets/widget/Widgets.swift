import SwiftUI
import WidgetKit

private let showsURL = URL(string: "tvwatchtime://shows")!
private let appURL = URL(string: "tvwatchtime://")!

private func episodeURL(_ id: String) -> URL {
  URL(string: "tvwatchtime://episode/\(id)") ?? showsURL
}

/// Multi-network shows store "A · B" (NETWORK_SEPARATOR in @tvwatch/shared) — compact
/// widget rows show the first network only, like the app's cards.
private func firstNetwork(_ network: String) -> String {
  network.components(separatedBy: " · ").first ?? network
}

// MARK: - Watch Next (mirrors the app's EpisodeCard)

struct WatchNextRowView: View {
  let row: WatchNextRowModel

  var body: some View {
    HStack(spacing: 10) {
      if let image = row.image {
        Image(uiImage: image)
          .resizable()
          .scaledToFill()
          .frame(width: 88, height: 50)
          .clipped()
          .cornerRadius(8)
      }
      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 6) {
          Text(row.item.showTitle)
            .font(.system(size: 11, weight: .bold))
            .foregroundStyle(WidgetTheme.primary)
            .lineLimit(1)
          Spacer(minLength: 0)
          if let network = row.item.network {
            Text(firstNetwork(network))
              .font(.system(size: 9))
              .foregroundStyle(WidgetTheme.textMuted)
              .lineLimit(1)
          }
        }
        HStack(spacing: 8) {
          Text(episodeCode(row.item.episode.seasonNumber, row.item.episode.number, separator: " | "))
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(WidgetTheme.textMuted)
          if row.item.remainingUnwatched > 1 {
            Text("+\(row.item.remainingUnwatched - 1)")
              .font(.system(size: 10, weight: .bold))
              .foregroundStyle(WidgetTheme.primary)
          }
        }
        Text(row.item.episode.title)
          .font(.system(size: 12, weight: .bold))
          .foregroundStyle(WidgetTheme.textPrimary)
          .lineLimit(1)
      }
    }
    .padding(6)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(WidgetTheme.surface)
    .cornerRadius(12)
  }
}

struct WatchNextWidgetView: View {
  let entry: WatchNextEntry

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(entry.labels.watchNext)
        .font(.system(size: 14, weight: .bold))
        .foregroundStyle(WidgetTheme.textPrimary)
        .frame(maxWidth: .infinity, alignment: .leading)

      if entry.signedOut {
        Spacer(minLength: 0)
        Text(entry.labels.signIn)
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(WidgetTheme.primary)
          .frame(maxWidth: .infinity, alignment: .center)
      } else if entry.rows.isEmpty {
        Spacer(minLength: 0)
        Text(entry.labels.emptyWatchNext)
          .font(.system(size: 12, weight: .medium))
          .foregroundStyle(WidgetTheme.textMuted)
          .multilineTextAlignment(.center)
          .frame(maxWidth: .infinity, alignment: .center)
      } else {
        ForEach(entry.rows) { row in
          Link(destination: episodeURL(row.item.episode.id)) {
            WatchNextRowView(row: row)
          }
        }
      }
      Spacer(minLength: 0)
    }
    .padding(12)
    .containerBackground(WidgetTheme.background, for: .widget)
    .widgetURL(entry.signedOut ? appURL : showsURL)
  }
}

struct WatchNextWidget: Widget {
  static let kind = "WatchNextWidget"

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: Self.kind, provider: WatchNextProvider()) { entry in
      WatchNextWidgetView(entry: entry)
    }
    .configurationDisplayName("Watch Next")
    .description("Your next episodes to watch.")
    .supportedFamilies([.systemMedium, .systemLarge])
  }
}

// MARK: - Upcoming (mirrors the app's UpcomingCard + bucket headers)

struct UpcomingRowView: View {
  let row: UpcomingRowModel
  let labels: WidgetLabels
  let localeIdentifier: String

  var body: some View {
    HStack(spacing: 10) {
      if let image = row.image {
        Image(uiImage: image)
          .resizable()
          .scaledToFill()
          .frame(width: 37, height: 56)
          .clipped()
          .cornerRadius(6)
      }
      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 6) {
          Text(row.item.title)
            .font(.system(size: 12, weight: .bold))
            .foregroundStyle(WidgetTheme.textPrimary)
            .lineLimit(1)
          Spacer(minLength: 0)
          if let label = row.item.label {
            Text(
              labels.episodeLabel(for: label).uppercased(
                with: Locale(identifier: localeIdentifier.replacingOccurrences(of: "-", with: "_"))
              )
            )
              .font(.system(size: 8, weight: .bold))
              .foregroundStyle(WidgetTheme.primaryForeground)
              .padding(.horizontal, 5)
              .padding(.vertical, 1)
              .background(WidgetTheme.primary)
              .cornerRadius(6)
          }
        }
        Text("\(episodeCode(row.item.seasonNumber, row.item.episodeNumber)) · \(row.item.episodeTitle ?? "")")
          .font(.system(size: 10, weight: .medium))
          .foregroundStyle(WidgetTheme.textMuted)
          .lineLimit(1)
        HStack(spacing: 6) {
          Text("\(shortAirDate(row.item.airDate, localeIdentifier: localeIdentifier, precise: row.item.airTime != nil))\(row.item.airTime.map { " · \($0)" } ?? "")")
            .font(.system(size: 10))
            .foregroundStyle(WidgetTheme.textMuted)
            .lineLimit(1)
          Spacer(minLength: 0)
          if let network = row.item.network {
            Text(firstNetwork(network))
              .font(.system(size: 9, weight: .bold))
              .foregroundStyle(WidgetTheme.primary)
              .lineLimit(1)
          }
        }
      }
    }
    .padding(6)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(WidgetTheme.surface)
    .cornerRadius(12)
  }
}

struct UpcomingWidgetView: View {
  let entry: UpcomingEntry

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(entry.labels.upcoming)
        .font(.system(size: 14, weight: .bold))
        .foregroundStyle(WidgetTheme.textPrimary)
        .frame(maxWidth: .infinity, alignment: .leading)

      if entry.signedOut {
        Spacer(minLength: 0)
        Text(entry.labels.signIn)
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(WidgetTheme.primary)
          .frame(maxWidth: .infinity, alignment: .center)
      } else if entry.sections.isEmpty {
        Spacer(minLength: 0)
        Text(entry.labels.emptyUpcoming)
          .font(.system(size: 12, weight: .medium))
          .foregroundStyle(WidgetTheme.textMuted)
          .multilineTextAlignment(.center)
          .frame(maxWidth: .infinity, alignment: .center)
      } else {
        ForEach(entry.sections) { section in
          Text(
            section.title.uppercased(
              with: Locale(identifier: entry.localeIdentifier.replacingOccurrences(of: "-", with: "_"))
            )
          )
            .font(.system(size: 10, weight: .bold))
            .foregroundStyle(WidgetTheme.textMuted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 2)
          ForEach(section.rows) { row in
            Link(destination: episodeURL(row.item.id)) {
              UpcomingRowView(
                row: row,
                labels: entry.labels,
                localeIdentifier: entry.localeIdentifier
              )
            }
          }
        }
      }
      Spacer(minLength: 0)
    }
    .padding(12)
    .containerBackground(WidgetTheme.background, for: .widget)
    .widgetURL(entry.signedOut ? appURL : showsURL)
  }
}

struct UpcomingWidget: Widget {
  static let kind = "UpcomingWidget"

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: Self.kind, provider: UpcomingProvider()) { entry in
      UpcomingWidgetView(entry: entry)
    }
    .configurationDisplayName("Upcoming")
    .description("Episodes airing today, tomorrow and this week.")
    .supportedFamilies([.systemMedium, .systemLarge])
  }
}
