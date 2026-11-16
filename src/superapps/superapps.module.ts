import { Global, Module } from '@nestjs/common';
import { SuperappsService } from './superapps.service';
import { SuperappsController } from './superapps.controller';

@Global()
@Module({ providers: [SuperappsService], controllers: [SuperappsController], exports: [SuperappsService] })
export class SuperappsModule {}
