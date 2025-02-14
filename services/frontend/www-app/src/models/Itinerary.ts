import { LineLayerSpecification, LngLat, LngLatBounds } from 'maplibre-gl';
import { i18n } from 'src/i18n/lang';
import {
  OTPAlert,
  OTPClient,
  OTPError,
  OTPErrorId,
  OTPItinerary,
  OTPItineraryLeg,
  OTPMode,
} from 'src/services/OTPClient';
import { DistanceUnits, TravelMode } from 'src/utils/models';
import {
  formatDistance,
  formatDuration,
  formatTime,
  kilometersToMiles,
} from 'src/utils/format';
import { decodeOtpPath } from 'src/third_party/decodePath';
import Trip, { LineStyles } from './Trip';
import { Err, Ok, Result } from 'src/utils/Result';

export enum ItineraryErrorCode {
  Other,
  SourceOutsideBounds,
  DestinationOutsideBounds,
  TransitServiceDisabled,
}

export class ItineraryError {
  errorCode: ItineraryErrorCode;
  message?: string;

  constructor(errorType: ItineraryErrorCode, message: string) {
    this.errorCode = errorType;
    this.message = message;
  }

  static fromOtp(otpError: OTPError): ItineraryError {
    if ('planError' in otpError) {
      const planError = otpError.planError;
      switch (planError.id) {
        case OTPErrorId.OutsideBounds: {
          if (planError.missing.includes('TO_PLACE')) {
            return {
              errorCode: ItineraryErrorCode.DestinationOutsideBounds,
              message: planError.msg,
            };
          } else {
            console.assert(planError.missing.includes('FROM_PLACE'));
            return {
              errorCode: ItineraryErrorCode.SourceOutsideBounds,
              message: planError.msg,
            };
          }
        }
        default: {
          return {
            errorCode: ItineraryErrorCode.Other,
            message: planError.message,
          };
        }
      }
    } else {
      const responseError = otpError.responseError;
      switch (responseError.status) {
        case 404: {
          return {
            errorCode: ItineraryErrorCode.TransitServiceDisabled,
          };
        }
        default: {
          return {
            errorCode: ItineraryErrorCode.Other,
          };
        }
      }
    }
  }
}

export default class Itinerary implements Trip {
  private raw: OTPItinerary;
  legs: ItineraryLeg[];
  private distanceUnits: DistanceUnits;
  withBicycle: boolean;

  constructor(
    otp: OTPItinerary,
    distanceUnits: DistanceUnits,
    withBicycle: boolean
  ) {
    this.raw = otp;
    this.legs = otp.legs.map((otpLeg) => new ItineraryLeg(otpLeg));
    this.distanceUnits = distanceUnits;
    this.withBicycle = withBicycle;
  }
  // We leave this blank for transit itineraries. It's not really relevant to
  // picking a trip, so we don't clutter the screen with it.
  lengthFormatted?: string | undefined;
  mode: TravelMode = TravelMode.Transit;

  public static async fetchBest(
    from: LngLat,
    to: LngLat,
    distanceUnits: DistanceUnits,
    departureTime?: string,
    departureDate?: string,
    arriveBy?: boolean,
    withBicycle?: boolean
  ): Promise<Result<Itinerary[], ItineraryError>> {
    const otpModes = [OTPMode.Transit];
    if (withBicycle) {
      otpModes.push(OTPMode.Bicycle);
    }

    const result = await OTPClient.fetchItineraries(
      from,
      to,
      5,
      otpModes,
      departureTime,
      departureDate,
      arriveBy
    );
    if (result.ok) {
      return Ok(
        result.value.map((otp) =>
          Itinerary.fromOtp(otp, distanceUnits, withBicycle ?? false)
        )
      );
    } else {
      return Err(ItineraryError.fromOtp(result.error));
    }
  }

  static fromOtp(
    raw: OTPItinerary,
    distanceUnits: DistanceUnits,
    withBicycle: boolean
  ): Itinerary {
    return new Itinerary(raw, distanceUnits, withBicycle);
  }

  public get duration(): number {
    return this.raw.duration;
  }

  public get durationFormatted(): string {
    return formatDuration(this.raw.duration, 'shortform');
  }

  public get startTime(): number {
    return this.raw.startTime;
  }

  public startStopTimesFormatted(): string {
    return i18n.global.t('time_range$startTime$endTime', {
      startTime: formatTime(this.startTime),
      endTime: formatTime(this.endTime),
    });
  }

  public get endTime(): number {
    return this.raw.endTime;
  }

  // Usually walking, but will be biking if mode is transit+bike
  get footDistanceMeters(): number {
    return this.raw.walkDistance;
  }

  public formattedFootDistance(): string {
    const km = this.footDistanceMeters / 1000;

    const preformattedDistance = (() => {
      if (this.distanceUnits == DistanceUnits.Kilometers) {
        return formatDistance(km, DistanceUnits.Kilometers);
      } else {
        const miles = kilometersToMiles(km);
        return formatDistance(miles, DistanceUnits.Miles);
      }
    })();

    if (this.withBicycle) {
      return i18n.global.t('bike_distance', { preformattedDistance });
    } else {
      return i18n.global.t('walk_distance', { preformattedDistance });
    }
  }

  public get viaRouteFormatted(): string | undefined {
    return this.legs
      .map((leg) => {
        if (leg.alerts.length > 0) {
          return leg.shortName + '⚠️';
        } else {
          return leg.shortName;
        }
      })
      .join(' → ');
  }

  public get alerts(): LegAlert[] {
    return this.legs.map((l) => l.alerts).flat();
  }

  public get firstTransitLeg(): ItineraryLeg | undefined {
    return this.legs.slice(0, 2).find((leg) => leg.transitLeg);
  }

  public get hasAlerts(): boolean {
    for (const leg of this.legs) {
      if (leg.alerts.length > 0) {
        return true;
      }
    }
    return false;
  }

  public get bounds(): LngLatBounds {
    const bounds = new LngLatBounds();
    for (const leg of this.legs) {
      const lineString = leg.geometry();
      for (const coord of lineString.coordinates) {
        bounds.extend([coord[0], coord[1]]);
      }
    }
    return bounds;
  }
}

export class ItineraryLeg {
  readonly raw: OTPItineraryLeg;
  constructor(otp: OTPItineraryLeg) {
    this.raw = otp;
  }

  get emoji(): string {
    switch (this.mode) {
      case OTPMode.Walk:
        return '🚶‍♀️';
      case OTPMode.Bus:
      case OTPMode.Transit:
        return '🚍';
      case OTPMode.Train:
      case OTPMode.Rail:
        return '🚆';
      case OTPMode.Subway:
        return '🚇';
      case OTPMode.Bicycle:
        return '🚲';
      case OTPMode.CableCar:
      case OTPMode.Tram:
        return '🚊';
      case OTPMode.Funicular:
        return '🚡';
      case OTPMode.Gondola:
        return '🚠';
      case OTPMode.Car:
        return '🚙';
      case OTPMode.Ferry:
        return '⛴️';
      default:
        console.error('no emoji for mode', this.mode);
        return '';
    }
  }

  get shortName(): string {
    const emoji = this.emoji;
    const shortName = this.raw.routeShortName ?? this.raw.route;
    return `${emoji} ${shortName}`.trim();
  }

  get mode(): OTPMode {
    return this.raw.mode;
  }

  geometry(): GeoJSON.LineString {
    const points: [number, number][] = decodeOtpPath(
      this.raw.legGeometry.points
    );
    return {
      type: 'LineString',
      coordinates: points,
    };
  }

  paintStyle(active: boolean): LineLayerSpecification['paint'] {
    if (active) {
      if (this.mode == OTPMode.Walk || this.mode == OTPMode.Bicycle) {
        return LineStyles.walkingActive;
      } else {
        if (this.raw.routeColor) {
          return LineStyles.activeColored(`#${this.raw.routeColor}`);
        } else {
          return LineStyles.active;
        }
      }
    } else {
      if (this.mode == OTPMode.Walk || this.mode == OTPMode.Bicycle) {
        return LineStyles.walkingInactive;
      } else {
        return LineStyles.inactive;
      }
    }
  }

  get sourceName(): string {
    return this.raw.from.name;
  }

  get destinationName(): string {
    return this.raw.to.name;
  }

  get sourceLngLat(): LngLat {
    return new LngLat(this.raw.from.lon, this.raw.from.lat);
  }

  get destinationLngLat(): LngLat {
    return new LngLat(this.raw.to.lon, this.raw.to.lat);
  }

  get duration(): number {
    return (this.raw.endTime - this.raw.startTime) / 1000;
  }

  get transitLeg(): boolean {
    return this.raw.transitLeg;
  }

  get startTime(): number {
    return this.raw.startTime;
  }

  get endTime(): number {
    return this.raw.endTime;
  }

  get realTime(): boolean {
    return this.raw.realTime;
  }

  get alerts(): LegAlert[] {
    return this.raw.alerts?.map((a) => new LegAlert(a)) || [];
  }
}

class LegAlert {
  raw: OTPAlert;

  constructor(otp: OTPAlert) {
    this.raw = otp;
  }

  get headerText(): string {
    return this.raw.alertHeaderText;
  }

  get descriptionText(): string {
    return this.raw.alertDescriptionText;
  }
}
