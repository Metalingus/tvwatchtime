import Foundation

/// DTOs decoded from the backend API (mirror of packages/shared/src/user.ts).

struct EpisodeBrief: Decodable {
  let id: String
  let seasonNumber: Int
  let number: Int
  let title: String
  let stillUrl: String?
}

struct WatchNextItem: Decodable, Identifiable {
  let showId: String
  let showTitle: String
  let backdropUrl: String?
  let network: String?
  let episode: EpisodeBrief
  let remainingUnwatched: Int
  let bucket: String

  var id: String { episode.id }
}

struct WatchNextResponse: Decodable {
  let items: [WatchNextItem]
}

struct UpcomingItem: Decodable, Identifiable {
  let id: String
  let title: String
  let posterUrl: String?
  let seasonNumber: Int?
  let episodeNumber: Int?
  let episodeTitle: String?
  let airDate: String
  let airTime: String?
  let network: String?
  let label: String?
}

struct UpcomingGroup: Decodable {
  let key: String
  let label: String
  let items: [UpcomingItem]
}

struct UpcomingResponse: Decodable {
  let groups: [UpcomingGroup]
}

struct RefreshResponse: Decodable {
  let accessToken: String
  let refreshToken: String
}

/// Localized strings pushed by the app (i18n) into the App Group container.
struct WidgetLabels {
  let watchNext: String
  let upcoming: String
  let today: String
  let tomorrow: String
  let thisWeek: String
  let labelNew: String
  let labelPremiere: String
  let labelLatest: String
  let labelAired: String
  let labelFinale: String
  let emptyWatchNext: String
  let emptyUpcoming: String
  let signIn: String

  static let fallback = WidgetLabels(
    watchNext: "Watch Next",
    upcoming: "Upcoming",
    today: "Today",
    tomorrow: "Tomorrow",
    thisWeek: "This week",
    labelNew: "New",
    labelPremiere: "Premiere",
    labelLatest: "Latest",
    labelAired: "Aired",
    labelFinale: "Finale",
    emptyWatchNext: "Your watch list is empty",
    emptyUpcoming: "No upcoming episodes",
    signIn: "Log in"
  )

  static func load(from defaults: UserDefaults?) -> WidgetLabels {
    guard
      let raw = defaults?.string(forKey: "widgetLabels"),
      let data = raw.data(using: .utf8),
      let dict = try? JSONDecoder().decode([String: String].self, from: data)
    else { return .fallback }
    return WidgetLabels(
      watchNext: dict["watchNext"] ?? fallback.watchNext,
      upcoming: dict["upcoming"] ?? fallback.upcoming,
      today: dict["today"] ?? fallback.today,
      tomorrow: dict["tomorrow"] ?? fallback.tomorrow,
      thisWeek: dict["thisWeek"] ?? fallback.thisWeek,
      labelNew: dict["labelNew"] ?? fallback.labelNew,
      labelPremiere: dict["labelPremiere"] ?? fallback.labelPremiere,
      labelLatest: dict["labelLatest"] ?? fallback.labelLatest,
      labelAired: dict["labelAired"] ?? fallback.labelAired,
      labelFinale: dict["labelFinale"] ?? fallback.labelFinale,
      emptyWatchNext: dict["emptyWatchNext"] ?? fallback.emptyWatchNext,
      emptyUpcoming: dict["emptyUpcoming"] ?? fallback.emptyUpcoming,
      signIn: dict["signIn"] ?? fallback.signIn
    )
  }

  func groupTitle(for key: String, fallback: String) -> String {
    switch key {
    case "TODAY": return today
    case "TOMORROW": return tomorrow
    case "THIS_WEEK": return thisWeek
    default: return fallback
    }
  }

  func episodeLabel(for value: String) -> String {
    switch value {
    case "NEW": return labelNew
    case "PREMIERE": return labelPremiere
    case "LATEST": return labelLatest
    case "AIRED": return labelAired
    case "FINALE": return labelFinale
    default: return value
    }
  }
}

func episodeCode(_ season: Int?, _ number: Int?, separator: String = " ") -> String {
  String(format: "S%02d\(separator)E%02d", season ?? 0, number ?? 0)
}

/// A compact date in the app-selected locale shared through the App Group. Accepts ISO
/// datetimes (the API serializes airDate with fractional seconds) and bare yyyy-MM-dd dates.
func shortAirDate(_ airDate: String, localeIdentifier: String, precise: Bool = false) -> String {
  let iso = ISO8601DateFormatter()
  iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  var date = iso.date(from: airDate)
  if date == nil {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyy-MM-dd"
    f.timeZone = TimeZone(secondsFromGMT: 0)
    date = f.date(from: airDate)
  }
  guard let d = date else { return airDate }
  let out = DateFormatter()
  out.locale = Locale(identifier: localeIdentifier.replacingOccurrences(of: "-", with: "_"))
  out.timeZone = precise ? TimeZone.current : TimeZone(secondsFromGMT: 0)
  out.setLocalizedDateFormatFromTemplate("EEE MMM d")
  return out.string(from: d)
}

func shortAirTime(_ airDate: String, localeIdentifier: String) -> String {
  let iso = ISO8601DateFormatter()
  iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  guard let date = iso.date(from: airDate) else { return "" }
  let out = DateFormatter()
  out.locale = Locale(identifier: localeIdentifier.replacingOccurrences(of: "-", with: "_"))
  out.timeStyle = .short
  out.timeZone = .current
  return out.string(from: date)
}
