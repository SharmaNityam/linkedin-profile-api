/**
 * The subset of LinkedIn's Voyager "normalized JSON" that we read. Everything
 * is optional because decorations change; the normalizer treats missing
 * fields as "not provided", never as fatal.
 *
 * Voyager responses are an entity graph: `data` references entities in
 * `included[]` by URN. Any key starting with `*` holds a URN (or URN list)
 * rather than an inline value.
 */

export interface VoyagerResponse {
  data?: VoyagerEntity;
  included?: VoyagerEntity[];
}

export interface VoyagerEntity {
  entityUrn?: string;
  $type?: string;
  [key: string]: unknown;
}

export interface VoyagerDate {
  year?: number;
  month?: number;
  day?: number;
}

export interface VoyagerDateRange {
  start?: VoyagerDate | null;
  end?: VoyagerDate | null;
}

export interface VectorArtifact {
  width?: number;
  height?: number;
  fileIdentifyingUrlPathSegment?: string;
}

export interface VectorImage {
  rootUrl?: string;
  artifacts?: VectorArtifact[];
}

export interface Paging {
  start?: number;
  count?: number;
  total?: number;
}

export interface CollectionResponse extends VoyagerEntity {
  paging?: Paging;
  '*elements'?: string[];
}

export const TYPES = {
  profile: 'com.linkedin.voyager.dash.identity.profile.Profile',
  positionGroup: 'com.linkedin.voyager.dash.identity.profile.PositionGroup',
  position: 'com.linkedin.voyager.dash.identity.profile.Position',
  education: 'com.linkedin.voyager.dash.identity.profile.Education',
  skill: 'com.linkedin.voyager.dash.identity.profile.Skill',
  certification: 'com.linkedin.voyager.dash.identity.profile.Certification',
  language: 'com.linkedin.voyager.dash.identity.profile.Language',
  volunteer: 'com.linkedin.voyager.dash.identity.profile.VolunteerExperience',
  project: 'com.linkedin.voyager.dash.identity.profile.Project',
  honor: 'com.linkedin.voyager.dash.identity.profile.Honor',
  publication: 'com.linkedin.voyager.dash.identity.profile.Publication',
  course: 'com.linkedin.voyager.dash.identity.profile.Course',
  company: 'com.linkedin.voyager.dash.organization.Company',
  school: 'com.linkedin.voyager.dash.organization.School',
  geo: 'com.linkedin.voyager.dash.common.Geo',
  industry: 'com.linkedin.voyager.dash.common.Industry',
  employmentType: 'com.linkedin.voyager.dash.identity.profile.EmploymentType',
  collection: 'com.linkedin.restli.common.CollectionResponse',
  // Company pages still come back decorated with the legacy (non-dash) family.
  legacyCompany: 'com.linkedin.voyager.organization.Company',
  legacyIndustry: 'com.linkedin.voyager.common.Industry',
  followingInfo: 'com.linkedin.voyager.common.FollowingInfo',
  // Feed entities, reached through the GraphQL profile-updates query.
  update: 'com.linkedin.voyager.dash.feed.Update',
  socialDetail: 'com.linkedin.voyager.dash.social.SocialDetail',
  socialActivityCounts: 'com.linkedin.voyager.dash.feed.SocialActivityCounts',
} as const;
